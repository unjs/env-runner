import type { IncomingMessage, Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import type { Hooks } from "crossws";
import type { ServerPlugin } from "srvx";
import type { EnvRunner } from "../types.ts";

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
 *   `WebSocket` client instead.
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
    target: (peer) => {
      const addr = getRunner()?.address;
      if (!addr?.port) {
        throw new Error("env runner worker is not ready");
      }
      const { pathname, search } = new URL(peer.request.url);
      return `ws://${addr.host || "127.0.0.1"}:${addr.port}${pathname}${search}`;
    },
    // Resolve the forwarded subprotocol defensively: on Deno the request is no
    // longer readable inside the `open` hook (after `Deno.upgradeWebSocket()`).
    forwardProtocol: (peer) => {
      try {
        const header = peer.request.headers.get("sec-websocket-protocol");
        return header
          ? header
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          : undefined;
      } catch {
        return undefined;
      }
    },
  });

  // An upgrade can arrive before the worker has reported its address (e.g. right
  // after a reload). The `upgrade` hook is awaited by every srvx adapter, so
  // wait for the runner to become ready before resolving the proxy target.
  const hooks: Partial<Hooks> = {
    ...proxy,
    async upgrade(request) {
      await getRunner()
        ?.waitForReady?.()
        .catch(() => {});
      return proxy.upgrade?.(request);
    },
  };

  return plugin({ resolve: () => hooks });
}
