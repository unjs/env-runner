# env-runner

Generic environment runner for Node.js. Ported from the nitro env runner concept into a standalone package.

> **Note:** Keep `AGENTS.md` updated with project status and structure.

> **Note:** Keep `README.md` usage section updated when adding/changing public API, CLI flags, or runner behavior.

## Architecture

```
src/
├── common/
│   ├── base-runner.ts       # BaseEnvRunner abstract class
│   ├── worker-utils.ts      # AppEntry interface, resolveEntry(), parseServerAddress()
│   ├── ws-proxy.ts          # createRunnerWSProxyPlugin() — runtime-native WS upgrade proxy (Node raw socket / Bun+Deno crossws bridge)
│   └── virtual-modules.ts   # registerVirtualModules() — registerHooks()/Bun.plugin wiring shared by node/bun/deno workers
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
│   │   ├── runner.ts          # MiniflareEnvRunner (Cloudflare Workers via miniflare)
│   │   ├── wrangler.ts        # loadWranglerConfig() — wrangler.{json,jsonc,toml} → Miniflare options
│   │   └── wrangler-import.ts # importWrangler() — mockable indirection for the optional wrangler dep
│   ├── vercel/
│   │   ├── runner.ts        # VercelEnvRunner (extends NodeWorkerEnvRunner)
│   │   ├── worker.ts        # Sets Vercel request context symbol, delegates to node-worker
│   │   ├── oidc.ts          # VERCEL_OIDC_TOKEN check + dev-time warning
│   │   └── queue-dev.ts     # Local Vercel Queues delivery bridge (registerDevConsumer)
│   └── netlify/
│       ├── runner.ts        # NetlifyEnvRunner (extends NodeWorkerEnvRunner)
│       └── worker.ts        # Sets global Netlify context, delegates to node-worker
├── types.ts                 # Core interfaces
├── virtual-loader.ts        # createVirtualHooks() — ESM resolve/load hooks for virtual modules
├── index.ts                 # Public API exports
├── loader.ts                # Dynamic runner loader
├── manager.ts               # RunnerManager for hot-reload
├── server.ts                # EnvServer (high-level API with watch mode)
└── cli.ts                   # CLI entry point
```

Detailed per-file notes, the shared `BaseEnvRunner` lifecycle, and `RunnerManager`/`EnvServer` behavior live in [`.agents/ARCHITECTURE.md`](.agents/ARCHITECTURE.md). Per-runner internals and virtual modules:

- **node-worker, node-process, bun-process, deno-process, self** — [`.agents/NODE-RUNNERS.md`](.agents/NODE-RUNNERS.md)
- **miniflare** (+ wrangler config) — [`.agents/MINIFLARE.md`](.agents/MINIFLARE.md)
- **vercel** — [`.agents/VERCEL.md`](.agents/VERCEL.md)
- **netlify** — [`.agents/NETLIFY.md`](.agents/NETLIFY.md)
- **Virtual modules** (Node + Bun + Deno + Miniflare) — [`.agents/VIRTUAL-MODULES.md`](.agents/VIRTUAL-MODULES.md)

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

The `websocket` property uses [crossws](https://crossws.h3.dev) hooks for cross-platform WebSocket support. Each built-in worker adds the crossws srvx plugin when `websocket` is defined. All built-in workers import `crossws/server`, which auto-selects the runtime adapter (node/bun/deno) via export conditions — matching srvx's own native runtime detection. This keeps the WebSocket adapter in sync with the underlying server: the node-worker/node-process workers inherit the host runtime (worker thread / `fork()`), so they use the native Bun.serve/Deno.serve adapter when env-runner runs on Bun or Deno instead of forcing Node compat. The `upgrade` property is a lower-level alternative for raw Node.js socket access (Node-only).

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
2. Dynamically imports the user's entry module (`resolveEntry()`); if this (or `registerVirtualModules()`) throws, the worker sends `{ event: "init-error", error }`, logs one concise `[env-runner] worker init failed: ...` line, and exits 1 — no uncaught-rejection stack dump on forwarded stderr
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

Generic test infrastructure, cross-runner suites (`runners.test.ts`, `manager.test.ts`, `server.test.ts`, `vite.test.ts`), and shared fixtures: [`.agents/TESTS.md`](.agents/TESTS.md). Runner-specific test notes live with each runner doc:

- orphan tests → [`.agents/NODE-RUNNERS.md`](.agents/NODE-RUNNERS.md)
- miniflare + wrangler tests → [`.agents/MINIFLARE.md`](.agents/MINIFLARE.md)
- vercel tests → [`.agents/VERCEL.md`](.agents/VERCEL.md)
- netlify tests → [`.agents/NETLIFY.md`](.agents/NETLIFY.md)
- virtual-module tests → [`.agents/VIRTUAL-MODULES.md`](.agents/VIRTUAL-MODULES.md)

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
- `cjs-module-lexer` / `es-module-lexer` — CJS named-export detection and ESM import-specifier parsing in the miniflare module fallback service (devDependencies inlined into `dist` by obuild)
- `@netlify/runtime` — Netlify compute runtime (optional peer dependency, used by `NetlifyEnvRunner` worker for full `globalThis.Netlify` + `globalThis.caches` setup)
- `wrangler` — Cloudflare Wrangler (optional peer dependency, used by `MiniflareEnvRunner`'s `wrangler` option to load a `wrangler.{json,jsonc,toml}` config via `unstable_readConfig` + `unstable_getMiniflareWorkerOptions`; a built-in minimal plain-JSON reader is used when it's absent)

## Reference docs (`.agents/`)

Runner-specific and deep-dive notes, split out of this file:

- [`.agents/ARCHITECTURE.md`](.agents/ARCHITECTURE.md) — detailed core source-file notes, the shared `BaseEnvRunner` lifecycle, `RunnerManager`/`EnvServer`
- [`.agents/NODE-RUNNERS.md`](.agents/NODE-RUNNERS.md) — node-worker, node-process, bun-process, deno-process, and self runners (+ orphan tests)
- [`.agents/MINIFLARE.md`](.agents/MINIFLARE.md) — Miniflare internals (`unsafeEvalBinding`, `unsafeModuleFallbackService`, service bindings) **and** the `MiniflareEnvRunner` + wrangler config + tests
- [`.agents/VERCEL.md`](.agents/VERCEL.md) — `VercelEnvRunner` (env vars, header injection, OIDC, Vercel Queues) + tests
- [`.agents/NETLIFY.md`](.agents/NETLIFY.md) — `NetlifyEnvRunner` (header injection) + tests
- [`.agents/VIRTUAL-MODULES.md`](.agents/VIRTUAL-MODULES.md) — virtual modules across Node/Bun/Deno/Miniflare + tests
- [`.agents/TESTS.md`](.agents/TESTS.md) — generic test infrastructure, cross-runner suites, shared fixtures
- [`.agents/SRVX.md`](.agents/SRVX.md) — srvx server framework notes (used by the built-in workers)
- [`.agents/PLAN.vite-compat.md`](.agents/PLAN.vite-compat.md) — Planned improvements for Vite Environment API compatibility (`waitForReady`, RPC, transport helpers)

## Key patterns

- **Co-located runner + worker** — Each runner directory contains both `runner.ts` and `worker.ts` (except `self/` which has no worker). Runners default to their co-located worker via `import.meta.resolve("env-runner/runners/<name>/worker")` when `entry` is omitted
- **Message-driven readiness** — Workers/processes post `{ address }` to signal ready state
- **Runtime-native WebSocket proxying** — The public-facing server attaches `RunnerManager.wsProxyPlugin()` (a srvx plugin from `src/common/ws-proxy.ts`). On a **Node** host it proxies the raw upgrade socket to the worker (httpxy passthrough via `runner.upgrade()`, transparent end-to-end); on a **Bun/Deno** host (no Node upgrade socket exists) it terminates the client with crossws and bridges to the worker over a `WebSocket` client. The plugin reads the active runner lazily so it survives hot-reloads. `runner.upgrade()` and the bridge both await readiness internally, so consumers don't poll. Replaced the old Node-only `server.node.server.on("upgrade")` wiring in `cli.ts`
- **Immediate shutdown** — `close()` immediately terminates the worker/process (no graceful shutdown handshake)
- **Orphan protection** — node-process/bun-process workers register `process.on("disconnect", () => process.exit(0))` at the top of the worker (before the entry import) so a non-graceful supervisor death (SIGKILL, crash) never leaves an orphan, even mid-import (#23)
- **Data passing:** Worker threads use `workerData`, processes use `ENV_RUNNER_DATA` env var (JSON), self runner uses in-memory channel, miniflare runner uses in-memory `script` with `unsafeModuleFallbackService` for module resolution
- **Stdio forwarding** — All runners forward entry stdout/stderr to the host process: node-process and bun-process pipe child streams to `process.stdout`/`process.stderr`, deno-process forwards non-IPC stdout lines (stdout doubles as NDJSON IPC) and pipes stderr, worker threads use Node.js's built-in forwarding, miniflare uses its default runtime stdio handler
- **Socket cleanup** — `_closeSocket()` avoids deleting Windows named pipes and abstract sockets
- **Custom inspect** — `[Symbol.for('nodejs.util.inspect.custom')]()` shows pending/ready/closed status
- **Adding a new runner** — Create `src/runners/<name>/runner.ts` extending `BaseEnvRunner`, optionally add `worker.ts`, add export path in `package.json`, add to `loaders` map in `src/loader.ts`, re-export from `src/index.ts`
