import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server/node";
import {
  resolveEntry,
  reloadEntryModule,
  parseServerAddress,
  isVirtualSpecifier,
  type AppEntry,
} from "../../common/worker-utils.ts";
import { registerVirtualModules, handleInvalidateModule } from "../../common/virtual-modules.ts";

// Exit when the supervisor disappears (graceful or crash) to avoid orphan workers.
// Registered before resolving the entry so a supervisor death during a slow
// entry import (e.g. opening DB pools) cannot leave an orphan behind.
process.on("disconnect", () => process.exit(0));

const data = JSON.parse(process.env.ENV_RUNNER_DATA || "{}");
const sendMessage = (message: unknown) => process.send!(message);
const virtualEntry = isVirtualSpecifier(data.entry, data.virtual);

let unregisterVirtualModules: () => void;
let entry: AppEntry;
try {
  unregisterVirtualModules = await registerVirtualModules(data.virtual);
  entry = await resolveEntry(data.entry, virtualEntry);
} catch (error: any) {
  // Report a structured error before exiting so the runner closes with a
  // meaningful cause instead of an uncaught rejection + bare exit code.
  const message = error?.message || String(error);
  sendMessage({ event: "init-error", error: message });
  console.error(`[env-runner] worker init failed: ${message}`);
  process.exit(1);
}

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

  if (message?.event === "invalidate-module") {
    handleInvalidateModule(message, sendMessage);
    return;
  }

  if (message?.type === "ping") {
    process.send!({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
