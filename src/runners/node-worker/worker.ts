import { parentPort, workerData } from "node:worker_threads";
import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server/node";
import { resolveEntry, reloadEntryModule, parseServerAddress } from "../../common/worker-utils.ts";

const data = workerData || {};
let entry = await resolveEntry(data.entry);
const sendMessage = (message: unknown) => parentPort?.postMessage(message);

const server = serve({
  port: 0,
  hostname: "127.0.0.1",
  silent: true,
  fetch: (request) => entry.fetch(request),
  middleware: entry.middleware,
  plugins: [...(entry.plugins || []), ...(entry.websocket ? [wsPlugin(entry.websocket)] : [])],
  gracefulShutdown: false,
});

await server.ready();

if (entry.upgrade) {
  server.node?.server?.on("upgrade", (req, socket, head) => {
    entry.upgrade!({ node: { req, socket, head } });
  });
}

if (entry.ipc) {
  await entry.ipc.onOpen?.({ sendMessage });
}

parentPort?.postMessage({
  address: parseServerAddress(server),
});

parentPort?.on("message", async (message) => {
  if (message?.event === "shutdown") {
    Promise.resolve(entry.ipc?.onClose?.())
      .then(() => server.close())
      .then(() => {
        parentPort?.postMessage({ event: "exit" });
      });
    return;
  }

  if (message?.event === "reload-module") {
    try {
      entry = await reloadEntryModule(data.entry, entry, sendMessage);
      parentPort?.postMessage({ event: "module-reloaded" });
    } catch (error: any) {
      parentPort?.postMessage({ event: "module-reloaded", error: error?.message || String(error) });
    }
    return;
  }

  if (message?.type === "ping") {
    parentPort?.postMessage({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
