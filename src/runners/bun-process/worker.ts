import { serve, type Server } from "srvx";
import { plugin as wsPlugin } from "crossws/server";
import {
  resolveEntry,
  reloadEntryModule,
  parseServerAddress,
  isVirtualEntry,
  toServerOptions,
  formatInitError,
  type AppEntry,
} from "../../common/worker-utils.ts";
import {
  registerVirtualModules,
  handleUpdateVirtualModules,
} from "../../common/virtual-modules.ts";
import { receiveProcessData } from "../../common/process-data.ts";

// Exit with the supervisor to avoid orphans; registered before a possibly slow entry import.
process.on("disconnect", () => process.exit(0));

// Runner data comes over IPC (env vars are size-limited), before any entry import.
const data = await receiveProcessData();
const sendMessage = (message: unknown) => process.send!(message);

let unregisterVirtualModules: () => void;
let entry: AppEntry;
let server: Server;
try {
  unregisterVirtualModules = await registerVirtualModules(data.virtual);
  // After registering: entry detection follows the live registrations.
  entry = await resolveEntry(data.entry, isVirtualEntry(data.entry));
  // The entry's own srvx options are forwarded, so `serve()` can throw on a
  // bad option — keep it inside the init-error path for an actionable message.
  server = serve({
    ...toServerOptions(entry),
    fetch: (request) => entry.fetch(request),
    plugins: [...(entry.plugins || []), ...(entry.websocket ? [wsPlugin(entry.websocket)] : [])],
  });
  await server.ready();
} catch (error: any) {
  // Report a structured error before exiting so the runner closes with a
  // meaningful cause instead of an uncaught rejection + bare exit code.
  const message = formatInitError(error);
  sendMessage({ event: "init-error", error: message });
  console.error(`[env-runner] worker init failed: ${message}`);
  process.exit(1);
}

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
      entry = await reloadEntryModule(data.entry, entry, sendMessage, isVirtualEntry(data.entry));
      process.send!({ event: "module-reloaded" });
    } catch (error: any) {
      process.send!({ event: "module-reloaded", error: error?.message || String(error) });
    }
    return;
  }

  if (message?.event === "update-virtual-modules") {
    handleUpdateVirtualModules(message, sendMessage);
    return;
  }

  if (message?.type === "ping") {
    process.send!({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
