# Node / Bun / Deno Runners (+ Self)

Built-in srvx-worker runners (node-worker, node-process, bun-process, deno-process) and the in-process `self` runner. Shared lifecycle: [`ARCHITECTURE.md`](ARCHITECTURE.md). Virtual modules: [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## node-worker

- `worker_threads.Worker`; data via `workerData`, IPC via `parentPort`. No `execArgv` option
- `env: hostEnv()` gives the thread its own `process.env` copy, so worker-side env writes (e.g. vercel's defaults) don't leak to the host

## node-process

- `fork()` with `ENV_RUNNER_DATA` (JSON) and `execArgv` (e.g. `--inspect`); child stdout/stderr piped to the host
- **Orphan protection** — the worker registers `process.on("disconnect", () => process.exit(0))` **before** importing the entry, so a supervisor SIGKILL/crash during a slow entry import (e.g. opening DB pools) still can't leave an orphan serving HTTP

## bun-process

- Always spawns the **Bun binary** (`~/.bun/bin/bun`, then `which bun`, then bare `bun`); only the spawn API depends on the host: `Bun.spawn({ ipc })` under Bun, Node `spawn()` with an `"ipc"` stdio slot under Node (not `fork()`, which would run Node)
- Same worker shape and orphan protection as node-process; `disconnect` relies on Bun's Node-compat layer (verified empirically on both hosts)

## deno-process

- `deno run -A --node-modules-dir=auto --no-lock <execArgv> <worker>` via Node `spawn()` with an `"ipc"` stdio slot and `serialization: "json"` — Deno implements Node's IPC channel (`NODE_CHANNEL_FD`, JSON only; verified on Deno 2.9), so messages must be JSON-serializable
- Same worker shape and orphan protection (`disconnect`) as node-process/bun-process; stdout/stderr are plain logs piped to the host

## self

- Imports the entry into the host process and calls `entry.fetch()` directly: no worker, no proxy, no server; readiness is a dummy `127.0.0.1:0` address
- Entry → host messages go through `queueMicrotask()` to avoid synchronous re-entrancy; `ping` is answered internally
- WebSockets: `entry.websocket` via a lazily created crossws Node adapter (closed with 1001 on reload/close), else `entry.upgrade`. A throwing upgrade destroys the socket itself (no upstream to settle it)
- `invalidateModule()` throws: the inherited IPC round-trip would leak `invalidate-module` into `ipc.onMessage` and hang until the ack timeout

## Testing

- `test/runners.test.ts` covers all of these (see `AGENTS.md` Testing)
- `test/host-env.test.ts` — `hostEnv()` precedence plus `FORCE_COLOR`/`COLUMNS` reaching node-worker/node-process workers
- `test/orphan.test.ts` — SIGKILLs a supervisor subprocess (node-process, bun-process on Node and Bun hosts, deno-process on a Node host), including mid-import via a slow-import entry with marker files. Probes the worker's **port**, not its pid: a killed-but-unreaped zombie still passes `kill(pid, 0)`
