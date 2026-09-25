# env-runner

Generic environment runner for Node.js. Ported from the nitro env runner concept into a standalone package.

> **Note:** Keep `AGENTS.md` updated with project status and structure.

> **Note:** Keep `README.md` usage section updated when adding/changing public API, CLI flags, or runner behavior.

## Architecture

```
src/
├── common/
│   ├── base-runner.ts       # BaseEnvRunner abstract class
│   ├── worker-utils.ts      # AppEntry interface, resolveEntry(), parseServerAddress(), toServerOptions()
│   ├── runtime-deps.ts      # resolveRuntimeDep()/resolveRuntimeDepSpecifier() — "module | specifier | false" resolver
│   ├── host-env.ts          # hostEnv() — worker/child env: host env + FORCE_COLOR/COLUMNS from the host TTY
│   ├── ws-proxy.ts          # createRunnerWSProxyPlugin() — runtime-native WS upgrade proxy
│   └── virtual-modules.ts   # registerVirtualModules() — registerHooks()/Bun.plugin wiring for node/bun/deno workers
├── runners/
│   ├── node-worker/         # NodeWorkerEnvRunner + worker (parentPort)
│   ├── node-process/        # NodeProcessEnvRunner + worker (process.send)
│   ├── bun-process/         # BunProcessEnvRunner + worker
│   ├── deno-process/        # DenoProcessEnvRunner + worker
│   ├── self/                # SelfEnvRunner (in-process, no worker)
│   ├── miniflare/           # MiniflareEnvRunner + wrapper.ts (in-memory workerd wrapper) + wrangler.ts (config → Miniflare options) + dotenv.ts (minimal-reader dev vars)
│   ├── vercel/              # VercelEnvRunner (extends node-worker) + worker, oidc.ts, queue-dev.ts
│   └── netlify/             # NetlifyEnvRunner (extends node-worker) + worker
├── types.ts                 # Core interfaces
├── virtual-loader.ts        # createVirtualHooks() — ESM resolve/load hooks for virtual modules
├── index.ts                 # Public API exports
├── loader.ts                # Dynamic runner loader
├── manager.ts               # RunnerManager for hot-reload
├── server.ts                # EnvServer (high-level API with watch mode)
└── cli.ts                   # CLI entry point
```

Exports: see `package.json` `exports` (`.`, `./runners/<name>`, `./runners/<name>/worker`, `./vite`).

## Built-in Workers

Each IPC-based runner defaults to its co-located `src/runners/<name>/worker.ts` (so `entry` is optional; `data.entry` points to the user module). Workers let users write a plain `export default { fetch }` module and start it with [srvx](https://srvx.h3.dev).

### User entry format (`AppEntry`)

```ts
export default {
  fetch(request: Request): Response | Promise<Response>,
  websocket?: Partial<Hooks>,  // crossws hooks (recommended)
  upgrade?: (ctx: { node: { req, socket, head } }) => void,  // raw upgrade (Node-only)
  middleware?: [], plugins?: [],
  ...ServerOptions, // other srvx options are forwarded to serve()
  ipc?: { onOpen?({ sendMessage }), onMessage?(message), onClose?() },
};
```

- `toServerOptions()` strips env-runner keys and pins/drops listener options (`RESERVED_SERVER_OPTIONS`, `RESERVED_RUNTIME_OPTIONS` for nested `node`/`bun`/`deno`) since the worker listens on `127.0.0.1:0` behind the runner proxy. Server options are read once at start; `reloadModule()` only swaps `fetch`.
- `websocket` uses `crossws/server`, which picks the adapter matching the host runtime (so node-worker/node-process use native Bun/Deno adapters when the host is Bun/Deno).
- `ipc.onMessage` receives only user messages (ping/pong/shutdown are filtered); `onOpen` runs before the ready signal.
- Worker flow: import entry → `serve()` + `ready()` → wire `upgrade` → `ipc.onOpen` → post `{ address }`. Any init failure posts `{ event: "init-error", error }`, logs one `[env-runner] worker init failed: ...` line and exits 1.

## Miniflare

Details in [`.agents/MINIFLARE.md`](.agents/MINIFLARE.md). In short: the wrapper handles requests like `srvx/cloudflare` (plugins/middleware/error, `request.runtime`/`ip`/`waitUntil`, internal `__ENV_RUNNER_*` bindings hidden from `env`); `wrangler` (`true` | path | inline config) + `wranglerConfigPath`/`wranglerEnv`/`wranglerEnvFiles` load wrangler configs into Miniflare options, with unsupported bindings dropped (warned) and user `miniflareOptions` winning. Supports miniflare v4 and v5: options are built in the v4 format and converted with v5's `convertV4MiniflareOptions`.

## Reference docs (`.agents/`)

- [`ARCHITECTURE.md`](.agents/ARCHITECTURE.md) — core source-file notes, `BaseEnvRunner` lifecycle, `RunnerManager`/`EnvServer`
- [`NODE-RUNNERS.md`](.agents/NODE-RUNNERS.md) — node-worker, node-process, bun-process, deno-process, self (+ orphan tests)
- [`MINIFLARE.md`](.agents/MINIFLARE.md) — Miniflare internals, `MiniflareEnvRunner`, wrangler config + tests
- [`VERCEL.md`](.agents/VERCEL.md) — `VercelEnvRunner` (env vars, headers, OIDC, Queues) + tests
- [`NETLIFY.md`](.agents/NETLIFY.md) — `NetlifyEnvRunner` + tests
- [`VIRTUAL-MODULES.md`](.agents/VIRTUAL-MODULES.md) — virtual modules across Node/Bun/Deno/Miniflare + tests

## Testing

- Runner tests spawn workers from `dist/` (resolved via the self-linked `env-runner` package), so run `pnpm build` after worker-side changes before `pnpm vitest run`
- `test/runners.test.ts` is the cross-runner suite; bun/deno cases auto-skip when the runtime is missing. Runner-specific test notes live in each runner doc

## Scripts

- `pnpm build` — obuild
- `pnpm dev` — Vitest watch
- `pnpm test` — lint + typecheck + vitest with coverage
- `pnpm typecheck` — tsgo
- `pnpm fmt` — automd + oxlint fix + oxfmt
- `pnpm lint` — oxlint + oxfmt check
- `pnpm release` — test + build + changelog + publish + push

## Dependencies

- `crossws`, `httpxy`, `srvx` — WebSocket hooks, HTTP/WS proxy, server framework
- `cjs-module-lexer` / `es-module-lexer` — devDependencies inlined into `dist` (miniflare module fallback service)
- **No peer dependencies.** `miniflare`, `wrangler`, `@netlify/runtime`, `@vercel/queue` are installed by the app and passed as runner options (`miniflare`, `wranglerModule`, `netlifyRuntime`, queue `sdk`), resolved via `resolveRuntimeDep()`: imported module | specifier (resolved from cwd) | `false` (opt out) | omitted (optional import). If nothing resolves: miniflare throws; wrangler → minimal JSON/JSONC reader; netlify → shim; queue → warn-once no-op. `netlifyRuntime` must be a specifier (imported inside the worker, via `resolveRuntimeDepSpecifier()`). These packages must stay listed as external in `build.config.mjs`.

## Key patterns

- **Message-driven readiness** — workers post `{ address }` when ready
- **WebSocket proxying** — `RunnerManager.wsSrvxPlugin()`: Node host proxies the raw upgrade socket (httpxy); Bun/Deno host terminates with crossws and bridges via a `WebSocket` client. Reads the active runner lazily (survives hot-reload) and awaits readiness
- **Immediate shutdown** — `close()` terminates the worker/process, no graceful handshake
- **Orphan protection** — node-process/bun-process/deno-process workers call `process.on("disconnect", () => process.exit(0))` before importing the entry
- **Data passing** — `workerData` (threads), `ENV_RUNNER_DATA` JSON env (processes), direct in-process import (self), in-memory `script` + `unsafeModuleFallbackService` (miniflare)
- **Terminal capabilities** — spawned workers get piped stdout, so `hostEnv()` forwards `FORCE_COLOR`/`COLUMNS` from the host TTY
- **Stdio forwarding** — all runners forward entry stdout/stderr to the host
- **Socket cleanup** — `_closeSocket()` skips Windows named pipes and abstract sockets
- **Adding a new runner** — `src/runners/<name>/runner.ts` extending `BaseEnvRunner` (+ optional `worker.ts`), add `package.json` export, add to `loaders` in `src/loader.ts`, re-export from `src/index.ts`
