# Testing

Generic test infrastructure and cross-runner suites. Runner-specific test notes live alongside each runner: [`NODE-RUNNERS.md`](NODE-RUNNERS.md) (orphan tests), [`MINIFLARE.md`](MINIFLARE.md) (miniflare + wrangler), [`VERCEL.md`](VERCEL.md), [`NETLIFY.md`](NETLIFY.md), [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## Setup

- Tests use vitest: `pnpm vitest run`
- **Note:** runner tests spawn workers from `dist/` (runners resolve their co-located worker via the self-linked `env-runner` package), so worker-side changes need `pnpm build` before `vitest run`

## Cross-runner & high-level suites

- **`test/runners.test.ts`** — Parameterized test suite for all IPC-based runner implementations (NodeWorker, NodeProcess, BunProcess, DenoProcess, Vercel, Netlify). Runners requiring specific runtimes (bun, deno) are auto-skipped when the runtime is not available
- **`test/manager.test.ts`** — Tests for `RunnerManager` lifecycle, hot-reload, message queueing, hook forwarding, `await using` disposal, and lazy reload-on-fetch after `invalidateModule()` (single shared reload for concurrent fetches; explicit `reloadModule()` satisfies the pending invalidation)
- **`test/server.test.ts`** — Tests for `EnvServer`: auto-start on first `fetch()`, idempotent/concurrent `start()`, no restart after `close()`, start-error propagation and retry, auto-reload on fetch after `invalidateModule()`
- **`test/vite.test.ts`** — Tests for Vite helpers: `createViteHotChannel` message namespacing/filtering/on/off, `createViteTransport` connect/send filtering

## Shared fixtures

- Test app fixture in `test/fixtures/app.mjs` — Minimal `export default { fetch }` entry for worker tests
- Test app fixture in `test/fixtures/app-rpc.mjs` — Entry with RPC handler for `rpc()` method tests
- Test fixture in `test/fixtures/app-upgrade.mjs` — Entry with WebSocket upgrade handler for upgrade tests
- Test fixture in `test/fixtures/app-websocket.mjs` — Entry with crossws WebSocket hooks for websocket tests

(Runner-specific fixtures — `worker-do.mjs`, `app-headers.mjs`, `app-env.mjs`, `app-virtual.mjs`, `virtual-unregister.mjs`, `app-pid.mjs`, `orphan-supervisor.mjs`, `app-slow-import.mjs` — are documented with their runners.)

## Coverage summary

Tests cover: lifecycle, fetch (GET/POST, relative URLs), WebSocket upgrade, crossws websocket, `RunnerManager.wsSrvxPlugin()` end-to-end through a real srvx server (Node passthrough), messaging, hooks, graceful close, inspect output, stdio forwarding (all runners), manager hot-reload, message queueing, miniflare hot-reload, vercel header/env/response injection, netlify header injection, waitForReady, vite helpers, orphan-worker exit on supervisor death, `await using` disposal (all runners + manager)
