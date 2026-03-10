# env-runner

Generic environment runner for Node.js. Ported from the nitro env runner concept into a standalone package.

> **Note:** Keep `README.md` usage section updated when adding/changing public API, CLI flags, or runner behavior.

## Architecture

```
src/
├── common/
│   ├── base-runner.ts       # BaseEnvRunner abstract class
│   └── worker-utils.ts      # AppEntry interface, resolveEntry(), parseServerAddress()
├── runners/
│   ├── node-worker/
│   │   ├── runner.ts        # NodeWorkerEnvRunner
│   │   └── worker.ts        # Built-in srvx worker (parentPort)
│   ├── node-process/
│   │   ├── runner.ts        # NodeProcessEnvRunner
│   │   └── worker.ts        # Built-in srvx worker (process.send)
│   ├── bun-process/
│   │   ├── runner.ts        # BunProcessEnvRunner
│   │   └── worker.ts        # Built-in srvx worker (Bun/Node.js)
│   └── self/
│       └── runner.ts        # SelfEnvRunner (in-process, no worker)
├── types.ts                 # Core interfaces
├── index.ts                 # Public API exports
├── loader.ts                # Dynamic runner loader
├── manager.ts               # RunnerManager for hot-reload
├── server.ts                # EnvServer (high-level API with watch mode)
└── cli.ts                   # CLI entry point
```

- **`src/types.ts`** — Core interfaces: `EnvRunner`, `WorkerAddress`, `WorkerHooks`, `RunnerRPCHooks`
- **`src/common/base-runner.ts`** — `BaseEnvRunner` abstract class + `EnvRunnerData`: shared logic for all runners (fetch proxy with exponential backoff, upgrade, message dispatch, graceful shutdown, socket cleanup)
- **`src/common/worker-utils.ts`** — Shared utilities for built-in workers: `AppEntry` interface, `resolveEntry()` to dynamically import user entry, `parseServerAddress()` to extract host/port from srvx server
- **`src/runners/node-worker/runner.ts`** — `NodeWorkerEnvRunner` extends `BaseEnvRunner`: spawns Node.js Worker threads, data via `workerData`
- **`src/runners/node-worker/worker.ts`** — Built-in srvx worker: reads `data.entry` from `workerData`, starts srvx server, reports address via `parentPort`
- **`src/runners/node-process/runner.ts`** — `NodeProcessEnvRunner` extends `BaseEnvRunner`: spawns a child process via `fork()`, supports custom `execArgv`
- **`src/runners/node-process/worker.ts`** — Built-in srvx worker: reads `data.entry` from `ENV_RUNNER_DATA`, starts srvx server, reports address via `process.send()`
- **`src/runners/bun-process/runner.ts`** — `BunProcessEnvRunner` extends `BaseEnvRunner`: uses `Bun.spawn()` with IPC when under Bun, falls back to Node.js `fork()` otherwise
- **`src/runners/bun-process/worker.ts`** — Built-in srvx worker: same as node-process worker (works on both Bun and Node.js)
- **`src/runners/self/runner.ts`** — `SelfEnvRunner` extends `BaseEnvRunner`: runs entry code in the same process using an in-memory channel registry on `process.__envRunners`
- **`src/loader.ts`** — `loadRunner(name, opts)`: dynamic loader that imports a runner by name (`node-worker` | `node-process` | `bun-process` | `self`) and returns an `EnvRunner` instance
- **`src/manager.ts`** — `RunnerManager`: proxy manager for hot-reload, message queueing, and listener forwarding across runner swaps
- **`src/server.ts`** — `EnvServer` extends `RunnerManager`: high-level API combining runner loading, watch mode (`fs.watch` with 100ms debounce), and auto-reload on file changes. Supports `watch` and `watchPaths` options
- **`src/cli.ts`** — CLI entry point: `env-runner <entry> [--runner] [--port] [--host] [-w/--watch]`
- **`src/index.ts`** — Public API: re-exports types, `BaseEnvRunner`, concrete runners, `SelfEnvRunner`, `RunnerManager`, `EnvServer`, and `loadRunner`

## How it works

`BaseEnvRunner` implements the shared `EnvRunner` lifecycle:

1. Runner takes an optional `entry` script path (defaults to co-located `worker.ts`/`.mjs`) and spawns it (Worker thread, child process, or in-process)
2. Entry posts `{ address: { host, port } }` or `{ address: { socketPath } }` when ready
3. `fetch()` proxies HTTP requests to the address via `httpxy` (retries with exponential backoff: 100ms → 1.6s, up to 5 attempts)
4. `upgrade()` proxies WebSocket upgrades
5. `sendMessage()` / `onMessage()` / `offMessage()` for bidirectional RPC
6. `close()` sends shutdown event, waits for graceful exit (configurable via `ENV_RUNNER_SHUTDOWN_TIMEOUT`, default 5s, disabled in CI/test), then terminates

Subclasses implement abstract methods: `sendMessage()`, `_hasRuntime()`, `_closeRuntime()`, `_runtimeType()`, and runtime init.

### NodeWorkerEnvRunner

Uses `worker_threads.Worker`. Entry communicates via `parentPort.postMessage()` / `parentPort.on('message')`. Data passed via `workerData`.

### NodeProcessEnvRunner

Uses `child_process.fork()`. Entry communicates via `process.send()` / `process.on('message')`. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv` (e.g. `--inspect`).

### BunProcessEnvRunner

Dual-runtime: uses `Bun.spawn()` with IPC callback when running under Bun, falls back to Node.js `child_process.fork()` otherwise. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv`.

### SelfEnvRunner

Runs entry code in the same process (no IPC, no forking). Uses an in-memory channel registry stored on `process.__envRunners` (Map). Entry modules retrieve their channel via query string: `import(entry + '?__envRunnerId=<id>')`. Communication uses `queueMicrotask()` to avoid synchronous re-entrancy. Exposes `SelfRunnerChannel` interface with `data`, `send()`, and `onMessage()`.

### RunnerManager

Proxy manager wrapping a runner with hot-reload support:

- `reload(runner)` — Swaps active runner, closes old one, preserves listeners
- Message queueing — `sendMessage()` queues when runner not ready, auto-flushes on ready
- Listener forwarding — `onMessage()`/`offMessage()` persist across runner swaps
- Hook wrapping — Detects unexpected runner exits, forwards `onReady()`/`onClose()` hooks
- Returns 503 from `fetch()`/`upgrade()` when no runner is active

### EnvServer

High-level API extending `RunnerManager` with runner loading and file watching:

- `start()` — Loads runner via `loadRunner()` and optionally starts file watchers
- `close()` — Stops watchers and closes the runner
- `watch: true` — Watches the entry file using `fs.watch()` with 100ms debounce; on change, creates a new runner and calls `reload()`
- `watchPaths` — Additional directories/files to watch (supports `recursive: true`)
- `onReload` hook — Called after a successful watch-triggered reload

## Built-in Workers

Pre-built worker scripts co-located with their runners (`src/runners/<name>/worker.ts`) that let users provide a simple `export default { fetch }` entry module instead of manually implementing the IPC/server boilerplate. Each worker uses [srvx](https://srvx.h3.dev) to start a standard HTTP server.

### User entry format (`AppEntry`)

```ts
export default {
  fetch(request: Request): Response | Promise<Response> {
    return new Response("Hello!");
  },
  middleware?: [],  // Optional srvx middleware
  plugins?: [],     // Optional srvx plugins
};
```

### Usage

Each IPC-based runner defaults to its co-located built-in worker, so `entry` is optional:

```ts
import { NodeProcessEnvRunner } from "env-runner";

// Uses default built-in worker automatically
const runner = new NodeProcessEnvRunner({
  name: "my-app",
  data: { entry: "./my-server.ts" },
});

// Or explicitly pass a custom entry
const runner2 = new NodeProcessEnvRunner({
  name: "my-app",
  entry: "/path/to/custom-worker.ts",
  data: { entry: "./my-server.ts" },
});
```

### How workers work

1. Worker receives `data.entry` path (via `workerData` or `ENV_RUNNER_DATA`)
2. Dynamically imports the user's entry module (`resolveEntry()`)
3. Starts a srvx server with `port: 0` on `127.0.0.1`
4. Reports `{ address: { host, port } }` via IPC
5. Handles `shutdown`/`exit` protocol and ping/pong messaging

### Worker ↔ Runner mapping

| Worker (`entry`)                                   | Runner                 |
| -------------------------------------------------- | ---------------------- |
| `env-runner/runners/node-worker/worker` (default)  | `NodeWorkerEnvRunner`  |
| `env-runner/runners/node-process/worker` (default) | `NodeProcessEnvRunner` |
| `env-runner/runners/bun-process/worker` (default)  | `BunProcessEnvRunner`  |
| _(no worker)_                                      | `SelfEnvRunner`        |

## Exports

- `env-runner` (`.`) — Types + all runners + `RunnerManager` + `AppEntry`
- `env-runner/runners/node-worker` (`./runners/node-worker`) — Direct import of `NodeWorkerEnvRunner`
- `env-runner/runners/node-worker/worker` (`./runners/node-worker/worker`) — Built-in srvx worker for Worker threads
- `env-runner/runners/node-process` (`./runners/node-process`) — Direct import of `NodeProcessEnvRunner`
- `env-runner/runners/node-process/worker` (`./runners/node-process/worker`) — Built-in srvx worker for Node.js child process
- `env-runner/runners/bun-process` (`./runners/bun-process`) — Direct import of `BunProcessEnvRunner`
- `env-runner/runners/bun-process/worker` (`./runners/bun-process/worker`) — Built-in srvx worker for Bun/Node.js process
- `env-runner/runners/self` (`./runners/self`) — Direct import of `SelfEnvRunner`

## Testing

- Tests use vitest: `pnpm vitest run`
- **`test/runners.test.ts`** — Parameterized test suite for all three IPC-based runner implementations (NodeWorker, NodeProcess, BunProcess)
- **`test/manager.test.ts`** — Tests for `RunnerManager` lifecycle, hot-reload, message queueing, hook forwarding
- Test app fixture in `test/fixtures/app.ts` — Minimal `export default { fetch }` entry for worker tests
- Tests cover: lifecycle, fetch (GET/POST), messaging, hooks, graceful close, inspect output, manager hot-reload, message queueing

## Scripts

- `pnpm build` — Build with obuild
- `pnpm dev` — Vitest watch mode
- `pnpm test` — Lint + typecheck + vitest with coverage
- `pnpm typecheck` — tsgo type checking
- `pnpm fmt` — Format (automd + oxlint fix + oxfmt)
- `pnpm lint` — Lint check (oxlint + oxfmt check)
- `pnpm release` — Test + build + changelog + publish + git push

## Dependencies

- `httpxy` — HTTP/WebSocket proxy
- `srvx` — Universal server framework (used by built-in workers)
- `std-env` — Environment detection (isCI, isTest)

## Key patterns

- **Co-located runner + worker** — Each runner directory contains both `runner.ts` and `worker.ts` (except `self/` which has no worker). Runners default to their co-located worker via `import.meta.resolve("env-runner/runners/<name>/worker")` when `entry` is omitted
- **Message-driven readiness** — Workers/processes post `{ address }` to signal ready state
- **Graceful shutdown protocol** — Runner sends `{ event: "shutdown" }`, entry must close server and respond with `{ event: "exit" }`
- **Data passing:** Worker threads use `workerData`, processes use `ENV_RUNNER_DATA` env var (JSON), self runner uses in-memory channel
- **Socket cleanup** — `_closeSocket()` avoids deleting Windows named pipes and abstract sockets
- **Custom inspect** — `[Symbol.for('nodejs.util.inspect.custom')]()` shows pending/ready/closed status
- **Adding a new runner** — Create `src/runners/<name>/runner.ts` extending `BaseEnvRunner`, optionally add `worker.ts`, add export path in `package.json`, add to `loaders` map in `src/loader.ts`, re-export from `src/index.ts`
