import type { IncomingMessage, Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import type { ServerPlugin } from "srvx";
import type { EnvRunner, WorkerAddress } from "../types.ts";

/**
 * Create a runtime-native WebSocket reverse-proxy plugin for the public srvx
 * server, forwarding upgrades to whichever runner is currently active.
 *
 * - **Node** — the `http.Server` `"upgrade"` event + raw-socket passthrough
 *   (httpxy, via `runner.upgrade()`). Transparent and single-framed: the worker
 *   performs the actual handshake, so subprotocol/extension negotiation stays
 *   end-to-end between the client and the worker.
 * - **Bun/Deno** — those runtimes serve natively (`Bun.serve`/`Deno.serve`) and
 *   expose no Node upgrade socket, so the raw passthrough can't work. Terminate
 *   the client WebSocket with crossws and bridge to the worker over a standard
 *   `WebSocket` client instead, using an async proxy `target` that awaits worker
 *   readiness (client frames buffer in the meantime) before dialing upstream.
 *
 * `getRunner` is read lazily on every upgrade so the plugin survives reloads —
 * the active runner (and its address) changes when the manager hot-reloads.
 */
export async function createRunnerWSProxyPlugin(
  getRunner: () => EnvRunner | undefined,
): Promise<ServerPlugin> {
  const isBun = "Bun" in globalThis;
  const isDeno = "Deno" in globalThis;

  // Node: raw-socket passthrough via the runner's `upgrade()` primitive. The
  // underlying http server only exists once the server is listening, so attach
  // the listener after `ready()`. `runner.upgrade()` waits for the worker.
  if (!isBun && !isDeno) {
    return (server) => {
      void server.ready().then(() => {
        const httpServer = server.node?.server as NodeHttpServer | undefined;
        httpServer?.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
          getRunner()?.upgrade?.({ node: { req, socket, head } });
        });
      });
    };
  }

  // Bun/Deno: terminate the client WebSocket with crossws and bridge it to the
  // worker with a standard `WebSocket` client.
  const { createWebSocketProxy } = await import("crossws");
  const { plugin } = isBun
    ? await import("crossws/server/bun")
    : await import("crossws/server/deno");

  const proxy = createWebSocketProxy({
    // An upgrade can arrive before the worker has reported its address (e.g.
    // right after a reload). The async target resolver (crossws >=0.4.7) awaits
    // readiness while client frames are buffered, instead of stalling the
    // client handshake. `forwardProtocol` defaults to forwarding the client's
    // `sec-websocket-protocol` verbatim, so no custom resolver is needed.
    target: async (peer) => {
      await getRunner()
        ?.waitForReady?.()
        .catch(() => {});
      return resolveWSProxyTarget(getRunner()?.address, peer.request.url);
    },
  });

  return plugin({ resolve: () => proxy });
}


/**
 * Build the upstream `ws://` URL the Bun/Deno bridge dials, from the worker's
 * reported address and the incoming request URL (path + query are preserved).
 *
 * Throws when the worker isn't ready yet, or when it listens on a Unix socket:
 * the bridge dials with a standard `WebSocket` client, which only speaks TCP
 * (the Node passthrough proxies the raw socket via httpxy and does support it).
 */
export function resolveWSProxyTarget(
  address: WorkerAddress | undefined,
  requestUrl: string,
): string {
  if (!address) {
    throw new Error("env runner worker is not ready");
  }
  if (address.socketPath) {
    throw new Error(
      `env runner worker listens on a Unix socket (${address.socketPath}), which the ` +
        `Bun/Deno WebSocket proxy bridge cannot dial with a TCP \`WebSocket\` client`,
    );
  }
  if (!address.port) {
    throw new Error("env runner worker is not ready");
  }
  // IPv6 literals must be bracketed in a URL authority (`[::1]:port`).
  const host = address.host || "127.0.0.1";
  const authority = host.includes(":") ? `[${host}]` : host;
  const { pathname, search } = new URL(requestUrl);
  return `ws://${authority}:${address.port}${pathname}${search}`;
}
