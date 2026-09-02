# Node / Bun / Deno Runners (+ Self)

The built-in srvx-worker runners (node-worker, node-process, bun-process, deno-process) and the in-process `self` runner. All extend `BaseEnvRunner` (see the shared lifecycle in [`AGENTS.md`](../AGENTS.md)).

## Source files

- **`src/runners/node-worker/runner.ts`** — `NodeWorkerEnvRunner` extends `BaseEnvRunner`: spawns Node.js Worker threads, data via `workerData`
- **`src/runners/node-worker/worker.ts`** — Built-in srvx worker: reads `data.entry` from `workerData`, registers `data.virtual` modules, starts srvx server, reports address via `parentPort`
- **`src/runners/node-process/runner.ts`** — `NodeProcessEnvRunner` extends `BaseEnvRunner`: spawns a child process via `fork()`, supports custom `execArgv`
- **`src/runners/node-process/worker.ts`** — Built-in srvx worker: reads `data.entry` from `ENV_RUNNER_DATA`, registers `data.virtual` modules, starts srvx server, reports address via `process.send()`
- **`src/runners/bun-process/runner.ts`** — `BunProcessEnvRunner` extends `BaseEnvRunner`: uses `Bun.spawn()` with IPC when under Bun, falls back to Node.js `fork()` otherwise
- **`src/runners/bun-process/worker.ts`** — Built-in srvx worker: same as node-process worker (works on both Bun and Node.js). Registers `data.virtual` modules via the shared `registerVirtualModules()` (uses the `Bun.plugin` backend under Bun, `registerHooks` under Node.js)
- **`src/runners/deno-process/runner.ts`** — `DenoProcessEnvRunner` extends `BaseEnvRunner`: spawns a `deno run --allow-all` child process with IPC via Node.js `spawn()`. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv`
- **`src/runners/deno-process/worker.ts`** — Built-in srvx worker for Deno: stdin/stdout newline-delimited JSON IPC (Deno lacks Node's `process.send`). Registers `data.virtual` modules via the shared `registerVirtualModules()` (feature-detected; Deno >= 2.x implements `registerHooks`, older Deno warns and skips). Otherwise mirrors the node-process worker
- **`src/runners/self/runner.ts`** — `SelfEnvRunner` extends `BaseEnvRunner`: runs entry code in the same process using an in-memory channel registry on `process.__envRunners`. Overrides `invalidateModule()` to throw a clear "does not support virtual modules" error (the inherited IPC round-trip would leak the internal `invalidate-module` message into the entry's `ipc.onMessage` and hang until the ack timeout)

## How it works

### NodeWorkerEnvRunner

Uses `worker_threads.Worker`. Entry communicates via `parentPort.postMessage()` / `parentPort.on('message')`. Data passed via `workerData`.

### NodeProcessEnvRunner

Uses `child_process.fork()`. Entry communicates via `process.send()` / `process.on('message')`. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv` (e.g. `--inspect`).

### BunProcessEnvRunner

Dual-runtime: uses `Bun.spawn()` with IPC callback when running under Bun, falls back to Node.js `child_process.fork()` otherwise. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv`.

### DenoProcessEnvRunner

Spawns a Deno child process via Node.js `child_process.spawn()` with `deno run --allow-all --node-modules-dir=auto` and an IPC channel (`stdio: ["pipe", "pipe", "pipe", "ipc"]`). Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv`. Uses the same worker as node-process (Deno's Node.js compatibility layer handles `process.send()`/`process.on("message")`).

### SelfEnvRunner

Runs entry code in the same process (no IPC, no forking). Uses an in-memory channel registry stored on `process.__envRunners` (Map). Entry modules retrieve their channel via query string: `import(entry + '?__envRunnerId=<id>')`. Communication uses `queueMicrotask()` to avoid synchronous re-entrancy. Exposes `SelfRunnerChannel` interface with `data`, `send()`, and `onMessage()`.

### Terminal capabilities

All four spawning runners build their env with `hostEnv()` (`src/common/host-env.ts`) instead of a bare `{ ...process.env }`, so worker-side code sees `FORCE_COLOR=1` and `COLUMNS` when the host is an interactive terminal (#37). `SelfEnvRunner` runs in the host process and needs nothing.

## Testing

The cross-runner parameterized suite (`test/runners.test.ts`) covers these runners too — see [`TESTS.md`](TESTS.md). Virtual-module tests live in [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

- **`test/host-env.test.ts`** — `hostEnv()` unit tests (TTY propagation, `NO_COLOR`/explicit-value precedence, non-TTY host) plus integration tests asserting `FORCE_COLOR`/`COLUMNS` reach the worker for node-worker and node-process (#37)
- **`test/orphan.test.ts`** — Regression tests for orphaned workers (#23): SIGKILLs the supervisor process and asserts the worker stops serving HTTP, plus mid-import variants asserting the worker exits even when the supervisor dies during a slow entry import (node-process, bun-process under both Node and Bun hosts)
- Test fixture in `test/fixtures/app-pid.mjs` — Entry that responds with the worker `process.pid` for orphan tests
- Test fixture in `test/fixtures/orphan-supervisor.mjs` — Standalone supervisor process that spawns a runner, prints worker pid/address, and stays alive until SIGKILLed (for orphan tests)
- Test fixture in `test/fixtures/app-slow-import.mjs` — Entry with a slow (3s) top-level import that writes start/finish marker files, for mid-import orphan tests
