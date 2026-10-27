// Runs under a Bun/Deno host to exercise the `createRunnerWSProxyPlugin`
// Bun/Deno bridge to a `MiniflareEnvRunner` (dialed at workerd's direct
// socket, which the runner reports as its address). Prints the front URL as
// `READY <url>` for the spawning test to connect to.
import { fileURLToPath } from "node:url";
import { serve } from "srvx";
import * as miniflare from "miniflare";
import { RunnerManager } from "../../src/manager.ts";
import { MiniflareEnvRunner } from "../../src/runners/miniflare/runner.ts";

const runner = new MiniflareEnvRunner({
  miniflare,
  name: "test-ws-bridge-miniflare",
  data: { entry: fileURLToPath(new URL("app-websocket.mjs", import.meta.url)) },
});
const manager = new RunnerManager(runner);
await manager.waitForReady();

const front = serve({
  port: 0,
  hostname: "127.0.0.1",
  plugins: [await manager.wsSrvxPlugin()],
  fetch: () => new Response("front"),
});
await front.ready();
console.log("READY " + front.url);

const exit = async () => {
  await runner.close();
  process.exit(0);
};
process.on("SIGTERM", exit);
process.on("SIGINT", exit);
