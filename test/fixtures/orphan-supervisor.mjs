// Supervisor process for orphan-worker regression tests (test/orphan.test.ts).
// Spawns a runner, prints the worker pid + address as JSON, then stays alive until killed.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const _dir = dirname(fileURLToPath(import.meta.url));
const entry = resolve(_dir, "app-pid.mjs");

const runnerName = process.argv[2];
const { NodeProcessEnvRunner } = await import("../../src/runners/node-process/runner.ts");
const { BunProcessEnvRunner } = await import("../../src/runners/bun-process/runner.ts");

let address;
const opts = {
  name: "orphan-test",
  data: { entry },
  hooks: {
    onReady: (_runner, addr) => {
      address = addr;
    },
  },
};

const runners = {
  "node-process": () => new NodeProcessEnvRunner(opts),
  "bun-process": () => new BunProcessEnvRunner(opts),
};

const runner = runners[runnerName]();
await runner.waitForReady();

const res = await runner.fetch("http://localhost/");
const workerPid = Number(await res.text());
console.log(JSON.stringify({ workerPid, address }));

// Keep the supervisor alive until killed externally (SIGKILL from the test)
setInterval(() => {}, 1000);
