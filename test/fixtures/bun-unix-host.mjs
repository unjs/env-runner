// Runs under a Bun host: a node-worker runner proxying to a unix-socket worker
// (`bun-unix-worker.mjs`). Prints the status of a streamed request body the
// worker rejects early, then of a small one, as `STATUS <early> <small>`.
import { NodeWorkerEnvRunner } from "../../src/runners/node-worker/runner.ts";

const runner = new NodeWorkerEnvRunner({
  name: "bun-unix",
  workerEntry: new URL("./bun-unix-worker.mjs", import.meta.url).pathname,
  data: { socketPath: process.argv[2] },
});
await runner.waitForReady();

const fetchStatus = (body) =>
  runner.fetch(new Request("http://localhost/", { method: "POST", body })).then(
    (res) => res.status,
    (error) => error.code || error.message,
  );

const early = await fetchStatus("x".repeat(128 * 1024));
const small = await fetchStatus("hello");
console.log(`STATUS ${early} ${small}`);
await runner.close();
