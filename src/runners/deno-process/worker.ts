import { serve } from "srvx";
import { resolveEntry, parseServerAddress } from "../../common/worker-utils.ts";

const data = JSON.parse(process.env.ENV_RUNNER_DATA || "{}");
const entry = await resolveEntry(data.entry);

const server = serve({
  port: 0,
  hostname: "127.0.0.1",
  silent: true,
  fetch: entry.fetch,
  middleware: entry.middleware,
  plugins: entry.plugins,
  gracefulShutdown: false,
});

await server.ready();

if (entry.ipc) {
  await entry.ipc.onOpen?.({
    sendMessage: (message) => process.send!(message),
  });
}

process.send!({
  address: parseServerAddress(server),
});

process.on("message", (message: any) => {
  if (message?.event === "shutdown") {
    Promise.resolve(entry.ipc?.onClose?.())
      .then(() => server.close())
      .then(() => {
        process.send!({ event: "exit" });
      });
    return;
  }

  if (message?.type === "ping") {
    process.send!({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
});
