import type { IncomingMessage, Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import type { Peer } from "crossws";
import type { ServerPlugin } from "srvx";
import type { EnvRunner, WorkerAddress } from "../types.ts";

/**
 * WebSocket proxy to the active runner (`getRunner` is read per upgrade to
 * survive reloads). Node passes the raw socket through, so the worker handshakes
 * end-to-end; Bun/Deno expose no upgrade socket, so crossws terminates and bridges.
 * `track` is called with the address a bridged WebSocket is dialed to (it may
 * throw to refuse it, closing the client with `1011`); the function it returns
 * runs once that WebSocket closes. Node upgrades are tracked by
 * `getRunner().upgrade()`.
 */
export async function createRunnerWSProxyPlugin(
  getRunner: () => EnvRunner | undefined,
  track?: (address: WorkerAddress | undefined) => (() => void) | undefined,
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

  // Per peer: the address its target resolved to, then the `track()` settle function.
  const addresses = new WeakMap<Peer, WorkerAddress | undefined>();
  const settles = new WeakMap<Peer, () => void>();
  const resolveTarget = (peer: Peer) => {
    const address = getRunner()?.address;
    addresses.set(peer, address);
    return resolveWSProxyTarget(address, peer.request.url);
  };
  const proxy = createWebSocketProxy({
    // Synchronous when ready, so crossws dials (`onUpstreamConnect()`) in the
    // same tick the address is read. Otherwise (e.g. mid-reload) the async
    // target (crossws >= 0.4.7) awaits readiness while client frames buffer,
    // instead of stalling the handshake.
    target: (peer) => {
      const runner = getRunner();
      if (runner?.ready) {
        return resolveTarget(peer);
      }
      return Promise.resolve(runner?.waitForReady?.())
        .catch(() => {})
        .then(() => resolveTarget(peer));
    },
    // Exactly one `onUpstreamClose()` per `onUpstreamConnect()` (crossws >= 0.4.16).
    onUpstreamConnect:
      track &&
      ((peer) => {
        const settle = track(addresses.get(peer));
        if (settle) settles.set(peer, settle);
      }),
    onUpstreamClose:
      track &&
      ((peer) => {
        settles.get(peer)?.();
        settles.delete(peer);
      }),
  });

  return plugin({ resolve: () => proxy });
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
