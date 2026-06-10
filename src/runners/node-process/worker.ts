import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server/node";
import {
  resolveEntry,
  reloadEntryModule,
  parseServerAddress,
  isVirtualSpecifier,
} from "../../common/worker-utils.ts";
import { registerVirtualModules } from "../../common/virtual-modules.ts";

const data = JSON.parse(process.env.ENV_RUNNER_DATA || "{}");
const unregisterVirtualModules = await registerVirtualModules(data.virtual);
const virtualEntry = isVirtualSpecifier(data.entry, data.virtual);
let entry = await resolveEntry(data.entry, virtualEntry);
const sendMessage = (message: unknown) => process.send!(message);

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

process.send!({
  address: parseServerAddress(server),
});

process.on("message", async (message: any) => {
  if (message?.event === "shutdown") {
    Promise.resolve(entry.ipc?.onClose?.())
      .then(() => server.close())
      .then(() => {
        unregisterVirtualModules();
        process.send!({ event: "exit" });
      });
    return;
  }

  if (message?.event === "reload-module") {
    try {
      entry = await reloadEntryModule(data.entry, entry, sendMessage, virtualEntry);
      process.send!({ event: "module-reloaded" });
    } catch (error: any) {
      process.send!({ event: "module-reloaded", error: error?.message || String(error) });
    }
    return;
  }

  if (message?.type === "ping") {
    process.send!({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
