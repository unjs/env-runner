# env-runner

Generic environment runner for Node.js. Ported from the nitro env runner concept into a standalone package.

> **Note:** Keep `AGENTS.md` updated with project status and structure.

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
│   ├── deno-process/
│   │   ├── runner.ts        # DenoProcessEnvRunner
│   │   └── worker.ts        # Built-in srvx worker (Deno)
│   ├── self/
│   │   └── runner.ts        # SelfEnvRunner (in-process, no worker)
│   ├── miniflare/
│   │   └── runner.ts        # MiniflareEnvRunner (Cloudflare Workers via miniflare)
│   ├── vercel/
│   │   ├── runner.ts        # VercelEnvRunner (extends NodeWorkerEnvRunner)
│   │   ├── worker.ts        # Sets Vercel request context symbol, delegates to node-worker
│   │   └── image.ts         # /_vercel/image optimization handler (IPX-based)
│   └── netlify/
│       ├── runner.ts        # NetlifyEnvRunner (extends NodeWorkerEnvRunner)
│       └── worker.ts        # Sets global Netlify context, delegates to node-worker
├── types.ts                 # Core interfaces
├── index.ts                 # Public API exports
├── loader.ts                # Dynamic runner loader
├── manager.ts               # RunnerManager for hot-reload
├── server.ts                # EnvServer (high-level API with watch mode)
└── cli.ts                   # CLI entry point
```

- **`src/vite.ts`** — Vite Environment API helpers: `createViteHotChannel()` (host-side HotChannel from runner RPC hooks) and `createViteTransport()` (worker-side ModuleRunner transport)
- **`src/types.ts`** — Core interfaces: `EnvRunner`, `WorkerAddress`, `WorkerHooks`, `RunnerRPCHooks`, `RPCOptions`
- **`src/common/base-runner.ts`** — `BaseEnvRunner` abstract class + `EnvRunnerData`: shared logic for all runners (fetch proxy with exponential backoff, upgrade, message dispatch, socket cleanup)
- **`src/common/worker-utils.ts`** — Shared utilities for built-in workers: `AppEntry` interface (with optional `websocket`, `upgrade`, and `ipc` hooks), `AppEntryIPC`/`AppEntryIPCContext` types, `resolveEntry()` to dynamically import user entry, `parseServerAddress()` to extract host/port from srvx server, `reloadEntryModule()` for cache-busted re-import with IPC teardown/re-init
- **`src/runners/node-worker/runner.ts`** — `NodeWorkerEnvRunner` extends `BaseEnvRunner`: spawns Node.js Worker threads, data via `workerData`
- **`src/runners/node-worker/worker.ts`** — Built-in srvx worker: reads `data.entry` from `workerData`, starts srvx server, reports address via `parentPort`
- **`src/runners/node-process/runner.ts`** — `NodeProcessEnvRunner` extends `BaseEnvRunner`: spawns a child process via `fork()`, supports custom `execArgv`
- **`src/runners/node-process/worker.ts`** — Built-in srvx worker: reads `data.entry` from `ENV_RUNNER_DATA`, starts srvx server, reports address via `process.send()`
- **`src/runners/bun-process/runner.ts`** — `BunProcessEnvRunner` extends `BaseEnvRunner`: uses `Bun.spawn()` with IPC when under Bun, falls back to Node.js `fork()` otherwise
- **`src/runners/bun-process/worker.ts`** — Built-in srvx worker: same as node-process worker (works on both Bun and Node.js)
- **`src/runners/deno-process/runner.ts`** — `DenoProcessEnvRunner` extends `BaseEnvRunner`: spawns a `deno run --allow-all` child process with IPC via Node.js `spawn()`. Data passed via `ENV_RUNNER_DATA` env var (JSON). Supports custom `execArgv`
- **`src/runners/deno-process/worker.ts`** — Built-in srvx worker: same as node-process worker (works on Deno via Node.js compat)
- **`src/runners/self/runner.ts`** — `SelfEnvRunner` extends `BaseEnvRunner`: runs entry code in the same process using an in-memory channel registry on `process.__envRunners`
- **`src/runners/miniflare/runner.ts`** — `MiniflareEnvRunner` extends `BaseEnvRunner`: runs entry in Cloudflare Workers runtime via miniflare. Overrides `fetch()` to use `mf.dispatchFetch()`. Uses in-memory `script` (no temp files), `unsafeModuleFallbackService` for module resolution, and `unsafeEvalBinding` for hot-reload via `reloadModule()`. Requires `miniflare` peer dependency
- **`src/runners/vercel/runner.ts`** — `VercelEnvRunner` extends `NodeWorkerEnvRunner`: simulates Vercel deployment environment with header injection and `/_vercel/image` optimization
- **`src/runners/vercel/worker.ts`** — Sets `Symbol.for("@vercel/request-context")` on globalThis, delegates to node-worker worker
- **`src/runners/vercel/image.ts`** — `createVercelImageHandler()`: handles `/_vercel/image` requests using IPX for image optimization. Supports `url`, `w`, `h`, `q`, `f`, `fit`, `blur`, `cache` query params. Validates remote URLs against `domains`/`remotePatterns`, local URLs against `localPatterns`, blocks SVG by default. Falls back to unoptimized proxy when `ipx` is not installed
- **`src/runners/netlify/runner.ts`** — `NetlifyEnvRunner` extends `NodeWorkerEnvRunner`: simulates Netlify deployment environment with header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`)
- **`src/runners/netlify/worker.ts`** — Uses `@netlify/runtime` `startRuntime()` when available (sets up `globalThis.Netlify` with env/context and `globalThis.caches`), falls back to lightweight shim. Delegates to node-worker worker
- **`src/loader.ts`** — `loadRunner(name, opts)`: dynamic loader that imports a runner by name (`node-worker` | `node-process` | `bun-process` | `deno-process` | `self` | `miniflare` | `vercel` | `netlify`) and returns an `EnvRunner` instance
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
5. `sendMessage()` / `onMessage()` / `offMessage()` for bidirectional messaging
6. `waitForReady(timeout?)` returns a promise that resolves when the runner becomes ready (address received)
7. `rpc(name, data?, opts?)` sends a request-response message over IPC (auto-generates ID, handles timeout, error propagation)
8. `reloadModule(timeout?)` re-imports the entry module without restarting the worker/process (cache-busted `import()`, IPC teardown/re-init)
9. `close()` immediately terminates the worker/process and cleans up sockets

Subclasses implement abstract methods: `sendMessage()`, `_hasRuntime()`, `_closeRuntime()`, `_runtimeType()`, and runtime init.

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

### MiniflareEnvRunner

Runs entry in the Cloudflare Workers runtime via [miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare). No worker file or HTTP proxy needed — overrides `fetch()` to call `mf.dispatchFetch()` directly. Accepts `miniflareOptions` for full Miniflare configuration (bindings, KV, D1, Durable Objects, etc.). Requires `miniflare` as a peer dependency.

**Entry loading:** Entry script path passed via `data.entry`. The runner generates an in-memory wrapper module (passed as `script` to Miniflare, no temp files) that imports the user entry and adds IPC glue. `scriptPath` is set to the entry's directory so workerd resolves relative imports correctly.

**Module resolution:** Uses `unsafeModuleFallbackService` + `unsafeUseModuleFallbackService` to resolve imports that workerd can't find on its own (e.g. imports from `node_modules`, parent directories, or cache-busted reload imports). The fallback reads files from disk relative to the entry directory. Supports cache-busting query strings (`?t=<version>`) for hot-reload.

**Module transform pipeline:** Optional `transformRequest` callback enables integration with Vite's (or any) transform pipeline. When provided, `unsafeModuleFallbackService` calls it with the resolved file path before falling back to raw disk reads. Returns `{ code: string }` or null. This enables TS/JSX/etc. compilation on-the-fly without pre-bundling. When `transformRequest` is set, the wrapper skips static `export *` re-exports (uses `dynamicOnly` mode) to avoid miniflare's ModuleLocator pre-walking the import tree, and adds `modulesRules` for `.ts`/`.tsx`/`.jsx`/`.mts` extensions.

**IPC:** Full bidirectional IPC (`ipc.onOpen`, `ipc.onMessage`, `ipc.onClose`) via a persistent WebSocket pair. During init, `dispatchFetch` with `upgrade: "websocket"` establishes a `WebSocketPair` — the runner keeps the client end, the worker wrapper keeps the server end. All messaging (user messages, reload commands, shutdown) flows over this single persistent connection as JSON. No per-message `dispatchFetch` overhead.

**Hot-reload:** `reloadModule()` sends `{ type: "reload", version }` over the WebSocket. The worker wrapper uses `unsafeEvalBinding` (`__ENV_RUNNER_UNSAFE_EVAL__`) to create a dynamic `import()` with a cache-busting query string. The module fallback service serves the fresh file from disk. Old entry's `ipc.onClose()` is called before swapping, new entry's `ipc.onOpen()` is called after. Worker sends `{ event: "module-reloaded" }` back over the WebSocket when done.

### VercelEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Vercel deployment environment. The worker sets `Symbol.for("@vercel/request-context")` on `globalThis` (with `waitUntil`, `cache`, `purge`, `addCacheTag`) for `@vercel/functions` compatibility, sets Vercel environment variables, then delegates to the node-worker worker.

**Environment variables** (set in worker thread, won't override if already set):

- `VERCEL` — `"1"`
- `VERCEL_ENV` — `"development"`
- `VERCEL_REGION` — `"dev1"`
- `NOW_REGION` — `"dev1"` (legacy alias)

**Request header injection:** Overrides `fetch()` to inject Vercel-specific headers before delegating to the parent:

- `x-vercel-deployment-url` — constructed from the worker's address (`http://<host>:<port>`)
- `x-vercel-id` — unique request ID in format `dev1::<podId>-<timestamp>-<hex>` (stable podId per process, matches vercel dev behavior)
- `x-vercel-forwarded-for` — derived from `x-forwarded-for` (first IP) or `x-real-ip`, defaults to `127.0.0.1`
- `x-forwarded-for`, `x-real-ip` — set to client IP if not already present
- `x-forwarded-proto` — protocol from request URL
- `x-forwarded-host` — from `host` header or request URL

**Response header injection:** After proxying, injects response headers:

- `server` — `"Vercel"`
- `x-vercel-id` — same request ID as the request header
- `x-vercel-cache` — `"MISS"`

All headers are only injected when not already present in the request/response.

**Image optimization (`/_vercel/image`):** Intercepts requests to `/_vercel/image` and processes images using IPX (optional `ipx` peer dependency). Supports Vercel's image optimization query parameters:

- `url` (required) — source image URL (local path or absolute URL)
- `w` (required) — output width in pixels
- `q` (optional, default 75) — quality 1–100
- `f` (optional) — output format as MIME type (`image/webp`, `image/avif`, etc.)
- `h` (optional) — output height in pixels
- `fit` (optional) — resize mode (`cover`, `contain`, `fill`, `inside`, `outside`)
- `blur` (optional) — blur amount
- `cache` (optional) — cache TTL override in seconds

Format auto-detection from `Accept` header when `f` is not provided (prefers avif > webp). Response includes `Vary: Accept` for proper cache keying. Local images are fetched from the worker; remote images are fetched directly. When `ipx` is not installed, warns once and falls back to proxying the unoptimized source image.

**URL validation:** Remote URLs are validated against `domains` (exact hostname match) and `remotePatterns` (protocol, hostname glob, port, pathname glob). Returns 400 when a remote URL doesn't match. Local URLs can be restricted via `localPatterns`. SVG sources are blocked by default (400) unless `dangerouslyAllowSVG` is true.

Constructor accepts optional `images` config (`VercelImageConfig`) matching the Vercel Build Output API `images` property: `sizes`, `domains`, `remotePatterns`, `localPatterns`, `qualities`, `formats`, `minimumCacheTTL`, `dangerouslyAllowSVG`, `contentSecurityPolicy`, `contentDispositionType`.

### NetlifyEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Netlify deployment environment. The worker sets `globalThis.Netlify` with `context` (null) and `env` (backed by `process.env`) for Netlify Functions API compatibility, then delegates to the node-worker worker.

**Header injection:** Overrides `fetch()` to inject Netlify-specific headers before delegating to the parent:

- `x-nf-client-connection-ip` — derived from `x-forwarded-for` (first IP) or `x-real-ip`, defaults to `127.0.0.1`
- `x-nf-account-id` — defaults to `"0"`
- `x-nf-site-id` — defaults to `"0"`
- `x-nf-deploy-id` — defaults to `"0"`
- `x-nf-deploy-context` — defaults to `"dev"`
- `x-nf-geo` — base64-encoded JSON geolocation object, defaults to `{ city: "localhost", country: { code: "dev" } }`
- `x-nf-request-id` — unique UUID per request via `crypto.randomUUID()`
- `x-forwarded-for`, `x-real-ip` — set to client IP if not already present
- `x-forwarded-proto` — protocol from request URL
- `x-forwarded-host` — from `host` header or request URL

All headers are only injected when not already present in the request.

### RunnerManager

Proxy manager wrapping a runner with hot-reload support:

- `reload(runner)` — Swaps active runner, closes old one, preserves listeners
- Message queueing — `sendMessage()` queues when runner not ready, auto-flushes on ready
- Listener forwarding — `onMessage()`/`offMessage()` persist across runner swaps
- Hook wrapping — Detects unexpected runner exits, forwards `onReady()`/`onClose()` multi-listener hooks (Set-based, mirrors `onMessage`/`offMessage` pattern)
- `onClose(listener)`/`offClose(listener)` — Multi-listener close events
- `onReady(listener)`/`offReady(listener)` — Multi-listener ready events
- Returns 503 from `fetch()`/`upgrade()` when no runner is active

### EnvServer

High-level API extending `RunnerManager` with runner loading and file watching:

- `start()` — Loads runner via `loadRunner()` and optionally starts file watchers
- `close()` — Stops watchers and closes the runner
- `watch: true` — Watches the entry file using `fs.watch()` with 100ms debounce; on change, creates a new runner and calls `reload()`
- `watchPaths` — Additional directories/files to watch (supports `recursive: true`)
- `onReload(listener)`/`offReload(listener)` — Multi-listener reload events (Set-based)

## Built-in Workers

Pre-built worker scripts co-located with their runners (`src/runners/<name>/worker.ts`) that let users provide a simple `export default { fetch }` entry module instead of manually implementing the IPC/server boilerplate. Each worker uses [srvx](https://srvx.h3.dev) to start a standard HTTP server.

### User entry format (`AppEntry`)

```ts
export default {
  fetch(request: Request): Response | Promise<Response> {
    return new Response("Hello!");
  },
  websocket?: Partial<Hooks>,  // Optional crossws WebSocket hooks (recommended)
  upgrade?: (context: { node: { req: IncomingMessage, socket: Socket, head: Buffer } }) => void,  // Optional raw WebSocket upgrade handler (Node.js only)
  middleware?: [],  // Optional srvx middleware
  plugins?: [],     // Optional srvx plugins
  ipc?: {
    onOpen?: (ctx: { sendMessage: (message: unknown) => void }) => void,
    onMessage?: (message: unknown) => void,
    onClose?: () => void,
  },
};
```

The `websocket` property uses [crossws](https://crossws.h3.dev) hooks for cross-platform WebSocket support. Each built-in worker adds the crossws srvx plugin when `websocket` is defined. Node.js workers use `crossws/server/node`, while bun/deno workers use `crossws/server` (auto-selects runtime). The `upgrade` property is a lower-level alternative for raw Node.js socket access.

The `ipc` property enables bidirectional messaging between the entry and the runner:

- `onOpen` — Called when the IPC channel is established (before ready signal), receives a `{ sendMessage }` context for sending messages back to the runner
- `onMessage` — Called when the runner sends a user message (internal messages like ping/pong and shutdown are filtered out)
- `onClose` — Called when the runner is shutting down

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
3. Starts a srvx server with `port: 0` on `127.0.0.1`, adding crossws srvx plugin if `entry.websocket` is defined
4. Wires `entry.upgrade()` to the underlying Node.js HTTP server's `upgrade` event (if defined)
5. Calls `entry.ipc.onOpen()` with `{ sendMessage }` if IPC hooks are defined
6. Reports `{ address: { host, port } }` via IPC
7. Forwards user messages to `entry.ipc.onMessage()` (filters out internal ping/pong and shutdown)
8. Calls `entry.ipc.onClose()` on shutdown before closing the server

### Worker ↔ Runner mapping

| Worker (`entry`)                                   | Runner                 |
| -------------------------------------------------- | ---------------------- |
| `env-runner/runners/node-worker/worker` (default)  | `NodeWorkerEnvRunner`  |
| `env-runner/runners/node-process/worker` (default) | `NodeProcessEnvRunner` |
| `env-runner/runners/bun-process/worker` (default)  | `BunProcessEnvRunner`  |
| `env-runner/runners/deno-process/worker` (default) | `DenoProcessEnvRunner` |
| _(no worker)_                                      | `SelfEnvRunner`        |
| _(in-memory wrapper module)_                       | `MiniflareEnvRunner`   |
| `env-runner/runners/vercel/worker` (default)       | `VercelEnvRunner`      |
| `env-runner/runners/netlify/worker` (default)      | `NetlifyEnvRunner`     |

## Exports

- `env-runner` (`.`) — Types + all runners + `RunnerManager` + `AppEntry`
- `env-runner/runners/node-worker` (`./runners/node-worker`) — Direct import of `NodeWorkerEnvRunner`
- `env-runner/runners/node-worker/worker` (`./runners/node-worker/worker`) — Built-in srvx worker for Worker threads
- `env-runner/runners/node-process` (`./runners/node-process`) — Direct import of `NodeProcessEnvRunner`
- `env-runner/runners/node-process/worker` (`./runners/node-process/worker`) — Built-in srvx worker for Node.js child process
- `env-runner/runners/bun-process` (`./runners/bun-process`) — Direct import of `BunProcessEnvRunner`
- `env-runner/runners/bun-process/worker` (`./runners/bun-process/worker`) — Built-in srvx worker for Bun/Node.js process
- `env-runner/runners/deno-process` (`./runners/deno-process`) — Direct import of `DenoProcessEnvRunner`
- `env-runner/runners/deno-process/worker` (`./runners/deno-process/worker`) — Built-in srvx worker for Deno process
- `env-runner/runners/self` (`./runners/self`) — Direct import of `SelfEnvRunner`
- `env-runner/runners/miniflare` (`./runners/miniflare`) — Direct import of `MiniflareEnvRunner`
- `env-runner/runners/vercel` (`./runners/vercel`) — Direct import of `VercelEnvRunner`
- `env-runner/runners/vercel/worker` (`./runners/vercel/worker`) — Vercel worker (sets request context, delegates to node-worker)
- `env-runner/runners/netlify` (`./runners/netlify`) — Direct import of `NetlifyEnvRunner`
- `env-runner/runners/netlify/worker` (`./runners/netlify/worker`) — Netlify worker (sets global Netlify context, delegates to node-worker)
- `env-runner/vite` (`./vite`) — Vite Environment API helpers (`createViteHotChannel`, `createViteTransport`)

## Testing

- Tests use vitest: `pnpm vitest run`
- **`test/runners.test.ts`** — Parameterized test suite for all IPC-based runner implementations (NodeWorker, NodeProcess, BunProcess, DenoProcess, Vercel, Netlify). Runners requiring specific runtimes (bun, deno) are auto-skipped when the runtime is not available
- **`test/manager.test.ts`** — Tests for `RunnerManager` lifecycle, hot-reload, message queueing, hook forwarding
- **`test/miniflare.test.ts`** — Tests for `MiniflareEnvRunner`: Durable Object exports, IPC alongside custom exports, hot-reload via `reloadModule()`, IPC re-initialization after reload
- **`test/vite.test.ts`** — Tests for Vite helpers: `createViteHotChannel` message namespacing/filtering/on/off, `createViteTransport` connect/send filtering
- Test app fixture in `test/fixtures/app.mjs` — Minimal `export default { fetch }` entry for worker tests
- Test app fixture in `test/fixtures/app-rpc.mjs` — Entry with RPC handler for `rpc()` method tests
- Test fixture in `test/fixtures/worker-do.mjs` — Worker with Durable Object export + IPC for miniflare tests
- Test fixture in `test/fixtures/app-upgrade.mjs` — Entry with WebSocket upgrade handler for upgrade tests
- Test fixture in `test/fixtures/app-websocket.mjs` — Entry with crossws WebSocket hooks for websocket tests
- Test fixture in `test/fixtures/app-headers.mjs` — Entry that echoes all request headers as JSON for vercel header injection tests
- Test fixture in `test/fixtures/app-env.mjs` — Entry that echoes request headers and selected environment variables as JSON
- Test fixture in `test/fixtures/app-image.mjs` — Entry that serves a 1x1 PNG at `/test.png` for vercel image optimization tests
- **`test/vercel.test.ts`** — Tests for `VercelEnvRunner`: request header injection (`x-vercel-deployment-url`, `x-vercel-id`, `x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-proto`, `x-forwarded-host`), response header injection (`server`, `x-vercel-id`, `x-vercel-cache`), environment variables (`VERCEL`, `VERCEL_ENV`, `VERCEL_REGION`, `NOW_REGION`), header preservation, pre-existing header respect, image optimization (`/_vercel/image` with format detection, Accept header negotiation, parameter validation, cache-control/Vary/Content-Length headers, SVG blocking, remote URL domain/pattern validation, sizes/qualities config enforcement)
- **`test/netlify.test.ts`** — Tests for `NetlifyEnvRunner`: header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`), IP derivation, header preservation
- Tests cover: lifecycle, fetch (GET/POST), WebSocket upgrade, crossws websocket, messaging, hooks, graceful close, inspect output, manager hot-reload, message queueing, miniflare hot-reload, vercel header/env/response injection, vercel image optimization (format negotiation, SVG protection, URL validation, config enforcement), netlify header injection, waitForReady, vite helpers

## Scripts

- `pnpm build` — Build with obuild
- `pnpm dev` — Vitest watch mode
- `pnpm test` — Lint + typecheck + vitest with coverage
- `pnpm typecheck` — tsgo type checking
- `pnpm fmt` — Format (automd + oxlint fix + oxfmt)
- `pnpm lint` — Lint check (oxlint + oxfmt check)
- `pnpm release` — Test + build + changelog + publish + git push

## Dependencies

- `crossws` — Cross-platform WebSocket hooks (used by built-in workers for `websocket` entry key)
- `httpxy` — HTTP/WebSocket proxy
- `srvx` — Universal server framework (used by built-in workers)
- `miniflare` — Cloudflare Workers simulator (optional peer dependency, required for `MiniflareEnvRunner`)
- `@netlify/runtime` — Netlify compute runtime (optional peer dependency, used by `NetlifyEnvRunner` worker for full `globalThis.Netlify` + `globalThis.caches` setup)
- `ipx` — Image optimization (optional peer dependency, used by `VercelEnvRunner` for `/_vercel/image` endpoint)

> **See also:** [`.agents/MINIFLARE.md`](.agents/MINIFLARE.md) — Miniflare internals, `unsafeEvalBinding`, `unsafeModuleFallbackService`, service bindings patterns
> **See also:** [`.agents/PLAN.vite-compat.md`](.agents/PLAN.vite-compat.md) — Planned improvements for Vite Environment API compatibility (`waitForReady`, RPC, transport helpers)

## Key patterns

- **Co-located runner + worker** — Each runner directory contains both `runner.ts` and `worker.ts` (except `self/` which has no worker). Runners default to their co-located worker via `import.meta.resolve("env-runner/runners/<name>/worker")` when `entry` is omitted
- **Message-driven readiness** — Workers/processes post `{ address }` to signal ready state
- **Immediate shutdown** — `close()` immediately terminates the worker/process (no graceful shutdown handshake)
- **Data passing:** Worker threads use `workerData`, processes use `ENV_RUNNER_DATA` env var (JSON), self runner uses in-memory channel, miniflare runner uses in-memory `script` with `unsafeModuleFallbackService` for module resolution
- **Socket cleanup** — `_closeSocket()` avoids deleting Windows named pipes and abstract sockets
- **Custom inspect** — `[Symbol.for('nodejs.util.inspect.custom')]()` shows pending/ready/closed status
- **Adding a new runner** — Create `src/runners/<name>/runner.ts` extending `BaseEnvRunner`, optionally add `worker.ts`, add export path in `package.json`, add to `loaders` map in `src/loader.ts`, re-export from `src/index.ts`
