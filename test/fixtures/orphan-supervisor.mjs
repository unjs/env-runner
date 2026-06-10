// Supervisor process for orphan-worker regression tests (test/orphan.test.ts).
// Spawns a runner, prints the worker pid + address as JSON, then stays alive until killed.
// With an entry name as third argument (e.g. "app-slow-import.mjs"), it skips the
// ready/fetch handshake and prints `{ started: true }` right after spawning instead.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const _dir = dirname(fileURLToPath(import.meta.url));

const runnerName = process.argv[2];
const entryName = process.argv[3] || "app-pid.mjs";
const entry = resolve(_dir, entryName);

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

if (entryName === "app-pid.mjs") {
  await runner.waitForReady();
  const res = await runner.fetch("http://localhost/");
  const workerPid = Number(await res.text());
  console.log(JSON.stringify({ workerPid, address }));
} else {
  console.log(JSON.stringify({ started: true }));
}

// Keep the supervisor alive until killed externally (SIGKILL from the test)
setInterval(() => {}, 1000);
