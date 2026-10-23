import type { IncomingMessage, Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import type { ServerPlugin } from "srvx";
import type { EnvRunner, WorkerAddress } from "../types.ts";

/**
 * WebSocket proxy to the active runner (`getRunner` is read per upgrade to
 * survive reloads). Node passes the raw socket through, so the worker handshakes
 * end-to-end; Bun/Deno expose no upgrade socket, so crossws terminates and bridges.
 * `track` is called when a bridged WebSocket connects to the runner's address;
 * the function it returns runs once that WebSocket closes (Node upgrades are
 * tracked by `getRunner().upgrade()`).
 */
export async function createRunnerWSProxyPlugin(
  getRunner: () => EnvRunner | undefined,
  track?: () => (() => void) | undefined,
): Promise<ServerPlugin> {
  const isBun = "Bun" in globalThis;
  const isDeno = "Deno" in globalThis;

  // The http server only exists once listening, so attach after `ready()`.
  if (!isBun && !isDeno) {
    return (server) => {
      void server
        .ready()
        .then(() => {
          const httpServer = server.node?.server as NodeHttpServer | undefined;
          httpServer?.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
            getRunner()?.upgrade?.({ node: { req, socket, head } });
          });
        })
        .catch(() => {
          // Never listened (e.g. port in use); the consumer's `serve()` surfaces it.
        });
    };
  }

  // Bun/Deno: terminate the client WebSocket with crossws and bridge it to the
  // worker with a standard `WebSocket` client.
  const { createWebSocketProxy } = await import("crossws");
  const { plugin } = isBun
    ? await import("crossws/server/bun")
    : await import("crossws/server/deno");

  // Open peers, with the `track()` settle function once connected.
  const peers = new Map<string, (() => void) | undefined>();
  const settle = (peer: { id: string }) => {
    peers.get(peer.id)?.();
    peers.delete(peer.id);
  };
  const proxy = createWebSocketProxy({
    // Async target (crossws >= 0.4.7) awaits readiness (e.g. mid-reload) while
    // client frames buffer, instead of stalling the handshake.
    target: async (peer) => {
      await getRunner()
        ?.waitForReady?.()
        .catch(() => {});
      const target = resolveWSProxyTarget(getRunner()?.address, peer.request.url);
      if (track && peers.has(peer.id)) {
        peers.set(peer.id, track());
      }
      return target;
    },
  });
  const hooks: typeof proxy = {
    ...proxy,
    open(peer) {
      peers.set(peer.id, undefined);
      return proxy.open?.(peer);
    },
    close(peer, details) {
      settle(peer);
      return proxy.close?.(peer, details);
    },
    error(peer, error) {
      settle(peer);
      return proxy.error?.(peer, error);
    },
  };

  return plugin({ resolve: () => (track ? hooks : proxy) });
}

/** Upstream URL for the Bun/Deno bridge (Deno needs `--unstable-net` for `ws+unix://`). */
export function resolveWSProxyTarget(
  address: WorkerAddress | undefined,
  requestUrl: string,
): string {
  if (!address) {
    throw new Error("env runner worker is not ready");
  }
  const { pathname, search } = new URL(requestUrl);
  if (address.socketPath) {
    // `ws+unix://<absolute-socket-path>:<request-path>`.
    return `ws+unix://${address.socketPath}:${pathname}${search}`;
  }
  if (!address.port) {
    throw new Error("env runner worker is not ready");
  }
  const host = address.host || "127.0.0.1";
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  // A TLS `listen` option (the client must accept the worker's certificate).
  const scheme = address.protocol === "https" ? "wss" : "ws";
  return `${scheme}://${authority}:${address.port}${pathname}${search}`;
}
