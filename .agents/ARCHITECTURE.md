# Architecture — Core Source Files

Non-obvious notes on the shared/core modules. Directory map: [`AGENTS.md`](../AGENTS.md). Runners: [`NODE-RUNNERS.md`](NODE-RUNNERS.md), [`MINIFLARE.md`](MINIFLARE.md), [`VERCEL.md`](VERCEL.md), [`NETLIFY.md`](NETLIFY.md). Virtual modules (`src/virtual-loader.ts`, `src/common/virtual-modules.ts`): [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## `BaseEnvRunner` (`src/common/base-runner.ts`)

- **Readiness** — the worker posts `{ address: { host, port } | { socketPath } }`. `fetch()` waits for it with exponential backoff (100ms → 1.6s, 5 tries), then returns 503. Relative fetch inputs resolve against a placeholder `http://localhost` (`_resolveFetchInput()`; runner fetch overrides must call it too)
- **`upgrade()` awaits readiness** (bounded) — an upgrade arriving during a (re)start would otherwise be dropped; on give-up the raw client socket is destroyed so it isn't leaked
- **`init-error` is fatal before ready** — built-in workers send `{ event: "init-error", error }` when the entry import / virtual registration / `serve()` throws; the runner closes with it as cause so callers see the real message, not "exited with code 1"
- **Closing rejects waiters promptly** — `waitForReady()` and every `_request()` (backing `rpc()`, `reloadModule()`, `invalidateModule()`) reject when the runner closes mid-wait, instead of waiting out the timeout on a dead worker
- **Virtual factories resolve on the host** before spawn (functions can't cross the worker boundary). The spawn stays synchronous when no factory is present; a throwing factory routes to `close(error)` (no unhandled rejection)
- **`invalidateModule()`** re-runs a factory source on the host and invalidates the module plus its transitive virtual importers in the worker; rejects for non-virtual specifiers
- **`_refreshVirtualSource()` awaits pending factory resolution** — until it settles, `_data.virtual` still aliases the caller's factory map; writing a string into it would permanently replace the factory and mutate the caller's options
- **`await using`** — `[Symbol.asyncDispose]()` → `close()` (also on `RunnerManager`/`EnvServer`), but `await using x = ...` does not await the initializer: async factories like `EnvServer.start()` need an inner `await`

## Common helpers

- **`worker-utils.ts`** — a specifier that is a `data.virtual` key skips all filesystem handling, so a virtual key **overrides** a real file at the same path. Reloads cache-bust real files by re-reading via a `data:` URL and bare/virtual specifiers via a `?__envRunnerReload=<n>` query (Bun backend re-registers the virtual module instead)
- **`runtime-deps.ts`** — bare specifiers resolve from cwd (app's `node_modules`); unresolvable ones pass through verbatim to `import()`, with failures wrapped in an actionable `TypeError`
- **`host-env.ts`** — explicit host `FORCE_COLOR`/`NO_COLOR`/`COLUMNS` always win
- **`ws-proxy.ts`** — Bun/Deno bridge targets `ws://host:port` or `ws+unix://<socket>:<path>` (Deno needs `--unstable-net` for Unix sockets) and forwards the subprotocol. Internal; public only via `RunnerManager.wsSrvxPlugin()`

## `RunnerManager` (`src/manager.ts`)

- `reload()` swaps the runner and closes the old one; message/ready/close listeners persist across swaps. With no argument it calls `_createRunner()` (throws on the base class; `EnvServer` overrides). A failed factory keeps the current runner attached
- `sendMessage()` queues until ready, then flushes
- `waitForReady()` registers via `onMessage()` so it is re-forwarded across reloads (a direct listener add would only resolve on the already-ready short-circuit)
- **Lazy invalidation** — `invalidateModule()` only marks dirty; the next `fetch()` runs one shared `reloadModule()` first (concurrent fetches share it; failure keeps the flag for retry). Explicit `reloadModule()` or `reload()` clears it
- `fetch()` goes through protected `_fetch()` so subclasses can hook it; `fetch()`/`upgrade()` return 503 with no active runner
- `wsSrvxPlugin()` passes the manager itself so `address`/`upgrade`/`waitForReady` follow the active runner across reloads

## `EnvServer` (`src/server.ts`)

- `start()` is idempotent and optional: the first `fetch()` auto-starts; a failed start resets so a later call retries. After `close()`, fetch stays 503 and never respawns
- `runnerOptions` is spread before the derived `name`/`hooks`/`data`/`execArgv` (carries deps like `{ miniflare }`; the CLI passes none)
- Watch mode: `fs.watch` with 100ms debounce on the entry + `watchPaths`, each change builds a fresh runner via `reload()`

## `loadRunner` (`src/loader.ts`)

- Its options index signature passes runner-specific options through untyped — hence the `RunnerConstructor` cast on the `miniflare` entry
