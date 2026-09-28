import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// deno-process workers run with `--node-modules-dir=auto`, so the first one
// installs the project's npm packages into `node_modules`. Do that once up
// front: suites spawning Deno workers in parallel on a cold cache block on the
// `node_modules` lock and exceed the test timeouts (CI). Without IPC the worker
// exits right after loading its imports; a missing `deno` is a no-op.
export default function setup() {
  const worker = fileURLToPath(new URL("../dist/runners/deno-process/worker.mjs", import.meta.url));
  spawnSync("deno", ["run", "-A", "--node-modules-dir=auto", "--no-lock", worker], {
    stdio: "ignore",
    timeout: 180_000,
  });
}
