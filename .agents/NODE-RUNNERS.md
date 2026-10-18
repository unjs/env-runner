# Node / Bun / Deno Runners (+ Self)

Built-in srvx-worker runners (node-worker, node-process, bun-process, deno-process) and the in-process `self` runner. Shared lifecycle: [`ARCHITECTURE.md`](ARCHITECTURE.md). Virtual modules: [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## node-worker

- `worker_threads.Worker`; data via `workerData`, IPC via `parentPort`. No `execArgv` option
- `env: hostEnv()` gives the thread its own `process.env` copy, so worker-side env writes (e.g. vercel's defaults) don't leak to the host

## Runner data (node-process, bun-process, deno-process)

- Delivered over **IPC, not the env**: Linux caps one env string at 128 KiB (`spawn E2BIG`), Windows the whole env block at ~32K chars, and `data.virtual` sources easily exceed both. Protocol in `src/common/process-data.ts`:
  1. worker attaches its `message` listener, **then** sends `{ event: "request-init-data" }` (so the reply can't arrive unobserved)
  2. host (`_handleProcessMessage()`) replies `{ event: "init-data", data: "<JSON>" }`; the request is internal, never forwarded to `onMessage` listeners
  3. worker removes its listener before importing the entry, so `init-data` never reaches `ipc.onMessage`. Readiness is still only the `{ address }` message
- `data` travels as a **JSON string** so every channel (Node/Deno `json`, Bun `advanced`) keeps the old `JSON.stringify()` semantics (functions dropped, `Date` → string). Raw IPC verified with 16–64 MiB messages to Node/Bun/Deno children from Node and Bun hosts
- `_processEnv()` snapshots `data` as JSON at spawn, with `data.virtual` bytes base64-encoded (`encodeVirtualModules()`, decoded by the worker's `registerVirtualModules()`; see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md#transport-bytes)); the reply sends that snapshot. There is no `ENV_RUNNER_DATA` env var, so custom `workerEntry` process workers must do the handshake too
- **Failures**: non-JSON-serializable data throws `Runner data must be JSON-serializable: ...` at spawn (constructor, or `close(cause)` after async virtual factories — `_initWithVirtualData()` routes deferred spawn errors to `close()`). A failing IPC reply logs `[env-runner] Failed to send runner data ...` and closes the runner with it as cause

## node-process

- `fork()` with `execArgv` (e.g. `--inspect`); runner data over IPC (above); child stdout/stderr piped to the host
- **Orphan protection** — the worker registers `process.on("disconnect", () => process.exit(0))` **before** the data handshake and entry import, so a supervisor SIGKILL/crash during a slow entry import (e.g. opening DB pools) still can't leave an orphan serving HTTP

## bun-process

- Always spawns the **Bun binary** (`~/.bun/bin/bun`, then `which bun`, then bare `bun`); only the spawn API depends on the host: `Bun.spawn({ ipc })` under Bun, Node `spawn()` with an `"ipc"` stdio slot under Node (not `fork()`, which would run Node)
- Same worker shape and orphan protection as node-process; `disconnect` relies on Bun's Node-compat layer (verified empirically on both hosts)

## deno-process

- `deno run -A --node-modules-dir=auto --no-lock <execArgv> <worker>` via Node `spawn()` with an `"ipc"` stdio slot and `serialization: "json"` — Deno implements Node's IPC channel (`NODE_CHANNEL_FD`, JSON only; verified on Deno 2.9), so messages must be JSON-serializable
- Same worker shape and orphan protection (`disconnect`) as node-process/bun-process; stdout/stderr are plain logs piped to the host

## Public listener (`listen`)

Runner option of node-worker, node-process, bun-process and deno-process (vercel/netlify inherit it untyped through node-worker's worker). User docs: README "Public listener (`listen`)".

- Sent as `data[LISTEN_DATA_KEY]` (`__envRunnerListen`); the worker passes it to `toServerOptions(entry, listen)`, which then uses its `port`/`hostname`/`protocol`/`tls`/`reusePort` (default: the entry's)/`silent` (default `true`) instead of `127.0.0.1:0`. Entry listener options stay ignored, `gracefulShutdown` stays `false` (the host owns signals: `shutdown()`). Omitted `port`/`hostname` fall back to srvx's defaults, read from the worker's env (`PORT` → 3000, `HOST` → all interfaces)
- `parseServerAddress()` reports where the host reaches it: brackets stripped (`::1`), wildcards as loopback (`0.0.0.0` → `127.0.0.1`, `::` → `::1`; Node binds `::` dual-stack only when IPv6 exists), the default port when the URL has none, `protocol: "https"` for TLS. The Bun/Deno WS bridge re-brackets IPv6 hosts
- Host `fetch()`/`upgrade()` still proxy to that address (HTTPS without certificate verification)
- A listen failure (`EADDRINUSE`; Bun: `Is port ... in use?`, Deno: `Address already in use`) is a `serve()`/`ready()` error, so it goes through `init-error` and closes the runner with it as cause
- Restart on crash is up to the caller (`RunnerManager.onClose()` + `reload()`, README example)

## self

- Imports the entry into the host process and calls `entry.fetch()` directly: no worker, no proxy, no server; readiness is a dummy `127.0.0.1:0` address
- Entry → host messages go through `queueMicrotask()` to avoid synchronous re-entrancy; `ping` is answered internally
- WebSockets: `entry.websocket` via a lazily created crossws Node adapter (closed with 1001 on reload/close), else `entry.upgrade`. A throwing upgrade destroys the socket itself (no upstream to settle it)
- `data.virtual`: registered in the host process before the entry import (`registerOwnedVirtualModules()`, after factories resolve); updates apply in-process via `_applyVirtualUpdates()` (no IPC), to that runner's registration only; `close()` unregisters. Hooks are process-global, Bun's plugin stays installed, and the module cache only grows. See [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md#self-runner-host-process)
- `plugins`: synchronous handlers only. The host registers the plugin loader hooks (`registerPluginHooks()` with `createDirectTransformClient()` → `pipeline.sync`) before its virtual modules (Bun: after), unregistered on `close()`; an async handler on an import or disk module fails it (`returned a Promise from ...`), virtual module transforms stay async. Hooks see every import in the process, and already loaded modules stay cached untransformed. See [`PLUGINS.md`](PLUGINS.md#per-runtime)
- An entry an earlier self runner in the process imported is imported fresh (`importFreshEntry()`), so it gets its own instance
- `plugins` close the runner with `Cannot use plugins`
- A close while the entry is still importing skips `ipc.onOpen` (the runtime is already torn down, so `onClose` would never run)
- `reloadModule()` uses the shared `reloadEntryModule()` in the host process (after pending virtual updates). So a reload imports through the host's loader (vitest's module runner under test, unless imported from `dist`), with the same cache-busting query as the workers

## Testing

- `test/runners.test.ts` covers all of these (see `AGENTS.md` Testing)
- `test/runners.test.ts` "reloadModule" (node-worker, node-process, bun-process, deno-process, self): fresh entry content, IPC re-init, and an entry with a relative import whose dependency stays cached
- `test/runners.test.ts` "runner data" (process runners) — handshake kept out of `ipc.onMessage`/host listeners, data > 128 KiB, serialization errors. `test/virtual.test.ts` serves a 1 MiB virtual module on every runner
- `test/listen.test.ts` — `listen` on node-worker, node-process, bun-process, deno-process: direct and proxied fetch, wildcard → loopback, `PORT` default, WebSocket on the public address, TLS (a self-signed cert from `openssl`, skipped without it), port in use, `shutdown()` order (in-flight `/slow` responds before `ipc.onClose`), `ipc.onClose` with a WebSocket still open, `RunnerManager.shutdown()` (messages reach manager listeners, a `close()` meanwhile), `toServerOptions()` with `listen`, `EnvServer.shutdown()` while starting; `self`/miniflare reject `listen`
- `test/host-env.test.ts` — `hostEnv()` precedence plus `FORCE_COLOR`/`COLUMNS` reaching node-worker/node-process workers
- `test/orphan.test.ts` — SIGKILLs a supervisor subprocess (node-process, bun-process on Node and Bun hosts, deno-process on a Node host), including mid-import via a slow-import entry with marker files. Probes the worker's **port**, not its pid: a killed-but-unreaped zombie still passes `kill(pid, 0)`
