# Architecture — Core Source Files

Non-obvious notes on the shared/core modules. Directory map: [`AGENTS.md`](../AGENTS.md). Runners: [`NODE-RUNNERS.md`](NODE-RUNNERS.md), [`MINIFLARE.md`](MINIFLARE.md), [`VERCEL.md`](VERCEL.md), [`NETLIFY.md`](NETLIFY.md). Virtual modules (`src/virtual-loader.ts`, `src/common/virtual-modules.ts`): [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## `BaseEnvRunner` (`src/common/base-runner.ts`)

- **Readiness** — the worker posts `{ address: { host, port } | { socketPath } }`. `fetch()` waits for it with exponential backoff (100ms → 1.6s, 5 tries), then returns 503. Relative fetch inputs resolve against a placeholder `http://localhost` (`_resolveFetchInput()`; runner fetch overrides must call it too)
- **`upgrade()` awaits readiness** (bounded) — an upgrade arriving during a (re)start would otherwise be dropped; on give-up the raw client socket is destroyed so it isn't leaked
- **`init-error` is fatal before ready** — built-in workers send `{ event: "init-error", error }` when the entry import / virtual registration / `serve()` throws; the runner closes with it as cause so callers see the real message, not "exited with code 1". `formatInitError()` adds where it was thrown when the message doesn't say (`dep failed (at virtual:#dep:2:7)`, see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md#error-messages))
- **Closing rejects waiters promptly** — `waitForReady()` and every `_request()` (backing `rpc()`, `reloadModule()`, `updateVirtualModules()`) reject when the runner closes mid-wait, instead of waiting out the timeout on a dead worker. The rejectors run from `close()` itself (`_pendingRequests`), since many closes arrive without any worker message (exit, spawn error, failed `self` entry import, miniflare init error)
- **`waitForReady()` carries the close cause** — it rejects with `Runner closed before becoming ready` and the `close()` cause as `error.cause`, also when called after the close (`_closeCause`)
- **Virtual factories resolve on the host** before spawn (functions can't cross the worker boundary), and every source is validated there (`normalizeVirtualModule()`: format, source type). The spawn stays synchronous when no factory is present and every source is valid; a throwing factory, an invalid source, or a spawn deferred behind one of them routes to `close(error)` (no unhandled rejection)
- **Process runner data** — `_processEnv()` (env + JSON snapshot of `data`) and `_handleProcessMessage()` (answers `request-init-data`) are the host side of the IPC data handshake, see [`NODE-RUNNERS.md`](NODE-RUNNERS.md)
- **`updateVirtualModules()`** sets/removes keys in one `update-virtual-modules` round trip; **`invalidateModule()`** is the same update with the key's current source (a factory re-runs), rejecting on the host for unknown keys. Both go through `_enqueueVirtualUpdate()`: one queue in call order, each after the initial factory resolution (until it settles, `_data.virtual` still aliases the caller's factory map), factories run before any change, then `_virtualSources`/`_data.virtual` (own copies from `_resolveVirtualData()`) change, and the runner is awaited before `_applyVirtualUpdates()` (miniflare overrides it). `reloadModule()` awaits the queue. See [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md#runtime-updates)
- **`await using`** — `[Symbol.asyncDispose]()` → `close()` (also on `RunnerManager`/`EnvServer`), but `await using x = ...` does not await the initializer: async factories like `EnvServer.start()` need an inner `await`

## Common helpers

- **`worker-utils.ts`** — a specifier that is a `data.virtual` key skips all filesystem handling, so a virtual key **overrides** a real file at the same path. Workers detect a virtual entry with `isVirtualEntry()`: path-aware under `registerHooks` (Node/Deno), exact on Bun. Miniflare uses the exact `isVirtualSpecifier()` (see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md))
- **Reload (`_importFresh()`)** re-imports the entry through the resolver with a `?__envRunnerReload=<n>` query, giving a fresh instance under its real identity. On Bun, a virtual entry is busted with `refreshVirtualModule()` instead (see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md))
  - Real files use a `file:` URL on Node/Deno (it re-reads the file, and absolute `C:\` paths need URLs), but an **absolute path** on Bun. Bun ignores a query on `file:` URLs and returns the cached module, but honors it on paths. Verified on Node 24, Bun 1.4 and Deno 2.9, on every runner, `self` included on all three hosts
  - A `data:` URL (the old approach) broke relative imports (non-hierarchical base) and, on Deno, any load once custom hooks are registered
  - **Only the entry is re-evaluated**: its own disk dependencies stay cached (virtual ones are refreshed by `invalidateModule()`/`updateVirtualModules()`, see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md)). Each reload leaves one more entry instance in the module map
- **`runtime-deps.ts`** — bare specifiers resolve from cwd (app's `node_modules`); unresolvable ones pass through verbatim to `import()`, with failures wrapped in an actionable `TypeError`
- **`host-env.ts`** — explicit host `FORCE_COLOR`/`NO_COLOR`/`COLUMNS` always win
- **`ws-proxy.ts`** — Bun/Deno bridge targets `ws://host:port` or `ws+unix://<socket>:<path>` (Deno needs `--unstable-net` for Unix sockets) and forwards the subprotocol. Internal; public only via `RunnerManager.wsSrvxPlugin()`

## `RunnerManager` (`src/manager.ts`)

- `reload()` swaps the runner and closes the old one; message/ready/close listeners persist across swaps. With no argument it calls `_createRunner()` (throws on the base class; `EnvServer` overrides). A failed factory keeps the current runner attached
- `sendMessage()` queues until ready, then flushes
- `waitForReady()` registers via `onMessage()` so it is re-forwarded across reloads (a direct listener add would only resolve on the already-ready short-circuit). It rejects early only when the manager itself closes, not the active runner (a later `reload()` may still bring one up)
- `_attach()` wraps the runner's `close()` to detect exits; runners close themselves through that wrapper, so it must forward the cause (to the runner's `hooks.onClose`/`waitForReady()` and to `onClose()` listeners)
- **Lazy invalidation** — `invalidateModule()`/`updateVirtualModules()` only mark dirty; the next `fetch()` runs one shared `reloadModule()` first (concurrent fetches share it; failure keeps the flag for retry). Explicit `reloadModule()` or `reload()` clears it. Both wait for the runner during a `reload()` (`_waitForRunner()`) and throw without one
- `fetch()` goes through protected `_fetch()` so subclasses can hook it; `fetch()`/`upgrade()` return 503 with no active runner
- `wsSrvxPlugin()` passes the manager itself so `address`/`upgrade`/`waitForReady` follow the active runner across reloads

## `EnvServer` (`src/server.ts`)

- `start()` is idempotent and optional: the first `fetch()` auto-starts; a failed start resets so a later call retries. After `close()`, fetch stays 503 and never respawns
- `runnerOptions` is spread before the derived `name`/`hooks`/`data`/`execArgv` (carries deps like `{ miniflare }`; the CLI passes none)
- Watch mode: `fs.watch` with 100ms debounce on the entry + `watchPaths`, each change builds a fresh runner via `reload()`
- `updateVirtualModules()` also applies the changes to the server's own copy of `data.virtual` (factories kept, the caller's options untouched), which `_createRunner()` passes to later runners. Without an active runner (before the first start, after close) the changes are only recorded

## `loadRunner` (`src/loader.ts`)

- Its options index signature passes runner-specific options through untyped — hence the `RunnerConstructor` cast on the `miniflare` entry
