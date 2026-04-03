import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server";
import { resolveEntry, reloadEntryModule, parseServerAddress } from "../../common/worker-utils.ts";

const data = JSON.parse(process.env.ENV_RUNNER_DATA || "{}");
let entry = await resolveEntry(data.entry);

// Deno doesn't support Node.js IPC (process.send), so use stdin/stdout JSON lines
const _stdout = (globalThis as any).Deno?.stdout
  ? { write: (s: string) => (globalThis as any).Deno.stdout.writeSync(new TextEncoder().encode(s)) }
  : process.stdout;
const sendMessage = (message: unknown) => _stdout.write(JSON.stringify(message) + "\n");

const _stdin = (globalThis as any).Deno?.stdin?.readable || process.stdin;

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

sendMessage({
  address: parseServerAddress(server),
});

// Read newline-delimited JSON from stdin
async function readMessages() {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of _stdin as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      await handleMessage(message);
    }
  }
}

async function handleMessage(message: any) {
  if (message?.event === "shutdown") {
    Promise.resolve(entry.ipc?.onClose?.())
      .then(() => server.close())
      .then(() => {
        sendMessage({ event: "exit" });
      });
    return;
  }

  if (message?.event === "reload-module") {
    try {
      entry = await reloadEntryModule(data.entry, entry, sendMessage);
      sendMessage({ event: "module-reloaded" });
    } catch (error: any) {
      sendMessage({ event: "module-reloaded", error: error?.message || String(error) });
    }
    return;
  }

  if (message?.type === "ping") {
    sendMessage({ type: "pong", data: message.data });
    return;
  }

  entry.ipc?.onMessage?.(message);
}

readMessages().catch(() => {});
