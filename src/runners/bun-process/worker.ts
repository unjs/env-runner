import { serve, type Server } from "srvx";
import { plugin as wsPlugin } from "crossws/server";
import {
  resolveEntry,
  reloadEntryModule,
  parseServerAddress,
  isVirtualSpecifier,
  toServerOptions,
  registerWorkerHooks,
  type AppEntry,
} from "../../common/worker-utils.ts";
import { handleInvalidateModule } from "../../common/virtual-modules.ts";

// Exit with the supervisor to avoid orphans; registered before a possibly slow entry import.
process.on("disconnect", () => process.exit(0));

const data = JSON.parse(process.env.ENV_RUNNER_DATA || "{}");
const sendMessage = (message: unknown) => process.send!(message);
const virtualEntry = isVirtualSpecifier(data.entry, data.virtual);

let unregisterHooks: () => void;
let entry: AppEntry;
let server: Server;
try {
  unregisterHooks = await registerWorkerHooks(data);
  entry = await resolveEntry(data.entry, virtualEntry);
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
  const message = error?.message || String(error);
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
        unregisterHooks();
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
