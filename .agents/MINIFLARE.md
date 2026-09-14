# Miniflare Internals & Patterns

## Worker Script Modes

Miniflare accepts scripts in three mutually exclusive modes:

### Mode A — Explicit `modules` array (in-memory)

```ts
new Miniflare({
  modules: [{ type: "ESModule", path: "/virtual/worker.mjs", contents: "export default ..." }],
  modulesRoot: "/",
});
```

- `contents` is optional — falls back to `readFileSync(path)` if omitted
- Module **name** inside workerd = `path.relative(modulesRoot, def.path)`
- `modulesRoot` defaults to `process.cwd()`

### Mode B — Inline `script` string

```ts
new Miniflare({
  script: "export default { fetch() { return new Response('hi'); } }",
  scriptPath: "/path/to/virtual-entry.mjs", // for resolution + stack traces
  modules: true, // ESM mode (vs service worker mode)
});
```

- `scriptPath` determines the base directory for resolving relative imports
- The file at `scriptPath` is **never read** — it's purely a virtual path
- This is what env-runner uses

### Mode C — File on disk (`scriptPath` only)

```ts
new Miniflare({ scriptPath: "/path/to/worker.mjs", modules: true });
```

## `unsafeEvalBinding`

Exposes workerd's `UnsafeEval` API inside the worker via a named binding.

```ts
new Miniflare({ unsafeEvalBinding: "UNSAFE_EVAL" });
```

### Interface inside the worker

```ts
interface UnsafeEval {
  eval(code: string, name?: string): unknown;
  newFunction(script: string, name?: string, ...args: string[]): Function;
  newAsyncFunction(script: string, name?: string, ...args: string[]): Function;
}
```

- `eval()` — evaluate JS code, return result. `name` is optional filename for debugging
- `newFunction()` — like `new Function(...args, script)` but allowed inside workerd
- `newAsyncFunction()` — same but creates an async function

### Use cases

- **Dynamic module loading**: Create `import()` via `newAsyncFunction("return await import(path)", "loader", "path")` then call with a specifier
- **Hot-reload**: Re-import modules with cache-busting query strings (`?t=<version>`)
- **Code evaluation**: The vite plugin uses this to evaluate Vite-transformed module source inside workerd

### Limitations

- Cannot directly execute ES module syntax (`export`, `import` declarations) — only expressions/statements
- For ESM, must use dynamic `import()` or have Vite pre-transform to CJS-compatible code

## `unsafeModuleFallbackService`

A **shared (top-level)** option — a callback invoked when workerd can't resolve a module import.

```ts
new Miniflare({
  unsafeModuleFallbackService(request) {
    const url = new URL(request.url);
    const specifier = url.searchParams.get("specifier"); // absolute resolved path
    const rawSpecifier = url.searchParams.get("rawSpecifier"); // as written in source
    const referrer = url.searchParams.get("referrer"); // importing module
    const method = request.headers.get("X-Resolve-Method"); // "import" or "require"

    // Return module contents as JSON
    return Response.json({ name: "relative/path.mjs", esModule: "export default 42;" });
  },
  workers: [
    {
      unsafeUseModuleFallbackService: true, // per-worker opt-in
      // ...
    },
  ],
});
```

### Response format (`Worker_Module`)

```ts
{ name: string } & (
  | { esModule: string }       // ES module source
  | { commonJsModule: string } // CJS source
  | { text: string }           // plain text
  | { data: number[] }         // binary (Uint8Array as array)
  | { wasm: number[] }         // WebAssembly (Uint8Array as array)
  | { json: string }           // JSON module
)
```

- Return `404` → module not found (workerd falls back to built-in resolution for `node:`/`cloudflare:`)
- Return `301` with `Location` header → redirect to another module path
- `name` must be a relative path (no leading `/`) — it's the module's identity inside workerd

### Cache busting

Module imports are cached by workerd. To force re-import (hot-reload), use query strings: `import("./entry.mjs?t=1")`. The fallback service strips the query when reading from disk but preserves it in `name` so workerd treats it as a new module.

## Service Bindings (IPC bridge)

Service bindings are the primary way to bridge between workerd and Node.js.

### Async function binding (most common)

```ts
serviceBindings: {
  MY_SERVICE: async (request: Request) => {
    // Runs in Node.js, receives fetch from the worker
    return new Response("from node");
  };
}
```

Inside the worker: `env.MY_SERVICE.fetch("http://host/path")` → calls the Node.js function.

### Node.js HTTP handler binding

```ts
serviceBindings: {
  MY_HTTP: { node: (req: IncomingMessage, res: ServerResponse) => { ... } }
}
```

Bridges workerd fetch to a raw Node.js HTTP handler. Used by vite plugin for `viteDevServer.middlewares`.

## Durable Objects as Singletons

The vite plugin uses a DO with special options to maintain persistent state across requests:

```ts
durableObjects: {
  __RUNNER__: {
    className: "RunnerObject",
    unsafeUniqueKey: kUnsafeEphemeralUniqueKey, // fixed key = singleton
    unsafePreventEviction: true,                // keep alive forever
  }
}
```

- `unsafeUniqueKey` with `kUnsafeEphemeralUniqueKey` → always returns the same DO instance
- `unsafePreventEviction` → DO stays in memory between requests
- Useful for holding WebSocket connections, module caches, or other stateful resources

## Vite Plugin Architecture (reference)

The vite plugin's approach to module evaluation:

1. **Wrapper entry** → generated in-memory module that creates Proxy-based classes
2. **Runner DO** → Durable Object holding a Vite `ModuleRunner` instance + WebSocket to dev server
3. **Module evaluation flow**: Vite transforms source → sends via WebSocket → `ModuleRunner` calls `unsafeEval` to execute inside workerd
4. **HMR**: File changes → Vite sends updated transforms → `ModuleRunner` re-evaluates → no Miniflare restart

### Internal bindings used by vite plugin

| Binding                  | Type              | Purpose                                          |
| ------------------------ | ----------------- | ------------------------------------------------ |
| `__VITE_RUNNER_OBJECT__` | Durable Object    | Singleton holding ModuleRunner + WebSocket state |
| `__VITE_INVOKE_MODULE__` | Service Binding   | Synchronous RPC from workerd to Vite             |
| `__VITE_UNSAFE_EVAL__`   | Eval Binding      | Code evaluation inside workerd                   |
| `__VITE_HTML_EXISTS__`   | Service Binding   | Check if HTML file exists (for assets)           |
| `__VITE_FETCH_HTML__`    | Service Binding   | Fetch + transform HTML via Vite pipeline         |
| `__VITE_MIDDLEWARE__`    | Node HTTP Binding | Bridge to Vite dev server middleware             |

All internal bindings are stripped from user-visible `env` via `stripInternalEnv()`.

### Module resolution tricks

- **`modulesRoot: "/"`** (or `"Z:\\"` on Windows) — makes module names = absolute paths without leading `/`
- **`unsafeModuleFallbackService`** — handles `.wasm`, `.bin`, `.txt`/`.html`/`.sql` imports via special marker strings (`__CLOUDFLARE_MODULE__<type>__<path>__`)
- **Virtual modules** — `virtual:cloudflare/worker-entry`, `virtual:cloudflare/user-entry` for entry chain with HMR acceptance

### Hot-reload edge case

When exports change (e.g. adding a new DurableObject), the plugin **restarts the entire Vite dev server** because Miniflare worker options (wrapper with export declarations) need regeneration. Normal code changes use HMR without restart.

---

# env-runner MiniflareEnvRunner

env-runner's Cloudflare Workers runner, built on the internals documented above. Virtual-module behavior on miniflare lives in [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).

## Source files

- **`src/runners/miniflare/runner.ts`** — `MiniflareEnvRunner` extends `BaseEnvRunner`: runs entry in Cloudflare Workers runtime via miniflare. Overrides `fetch()` to use `mf.dispatchFetch()`. Uses in-memory `script` (no temp files), `unsafeModuleFallbackService` for module resolution (serves `data.virtual` keys first — see "Virtual modules"), and `unsafeEvalBinding` for hot-reload via `reloadModule()`. Gets its `Miniflare` class from `#resolveMiniflare()` (called at the top of `#initAsync`), a thin wrapper over the shared `resolveRuntimeDep()` (`src/common/runtime-deps.ts`) with `expect: "Miniflare"` and `required: true`: the caller-supplied `miniflare` option — an imported module or a specifier — when given, otherwise an optional import of `miniflare`, throwing an actionable `TypeError` (with the import error as `cause`) only if that fails too. Async errors go through `#init()`'s catch, which logs and `close(error)`s the runner. Resolves `compatibilityDate` via `resolveCompatibilityDate()`: first defined of `miniflareOptions.compatibilityDate` > the runner's `compatibilityDate` option (`"latest"` → miniflare's exported `supportedCompatibilityDate`) > the wrangler-derived date, else `supportedCompatibilityDate` (`min(today, installed workerd binary date)`) rather than today's date, since the binary lags the calendar and a future date makes workerd refuse to start. The final value is **clamped**: a `YYYY-MM-DD` date newer than `supportedCompatibilityDate` (string compare) falls back to it with one `[env-runner] compatibility date ... is newer than the installed workerd supports` warning, whatever its source (mirrors `wrangler dev`). Optional `wrangler`/`wranglerEnv`/`wranglerConfigPath`/`wranglerModule` options load a `wrangler.{json,jsonc,toml}` config into Miniflare options via `loadWranglerConfig()` from the sibling `wrangler.ts` — see "Wrangler config"
- **`src/runners/miniflare/wrangler.ts`** — Wrangler config loading, extracted from the runner. Exports `loadWranglerConfig({ wrangler, env, entryPath, configPath, wranglerModule })` → `{ options?, configFile? }` (`configFile` = the config file actually loaded, unset for inline-only configs or skipped/failed files; the runner uses it as the first persist-root anchor) (the two-tier resolver — the caller-supplied `wrangler` module _or specifier_ resolved through the shared `resolveRuntimeDep()`, else its optional import of `wrangler`, else the built-in minimal JSON reader; `wranglerModule: false` skips straight to the minimal reader) and the `WranglerModule` structural type, `isPlainObject()` (the per-key shallow-merge guard also used by the runner's `#initAsync`), and the `WranglerInlineConfig` type (re-exported from `runner.ts` for API compatibility). Internal helpers (`findWranglerConfig()`, `readInlineWranglerConfig()`, `pickWranglerMiniflareOptions()`, `readWranglerConfigMinimal()`, `applyWranglerEnv()`, `mapWranglerConfigToMiniflare()`, `mergeWranglerMiniflareOptions()`, `filterLocalDurableObjects()`, the `WRANGLER_OPTION_DENYLIST` and `WRANGLER_OPTION_DROPLIST`, plus the dropped-option reporting helpers `addDropped()`/`describeDroppedOption()`/`warnDroppedWranglerOptions()` and `WRANGLER_DROPPED_OPTION_NAMES`) all live here too. The runner only calls `loadWranglerConfig()` and merges its result under `miniflareOptions`

## How it works

Runs entry in the Cloudflare Workers runtime via [miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare). No worker file or HTTP proxy needed — overrides `fetch()` to call `mf.dispatchFetch()` directly. Accepts `miniflareOptions` for full Miniflare configuration (bindings, KV, D1, Durable Objects, etc.). `miniflare` is **not a dependency** (not even a peer one): pass the imported module _or a specifier_ as the `miniflare` constructor option, or let `#resolveMiniflare()` fall back to an optional import resolved from the user's project. It throws only when both fail.

**Entry loading:** Entry script path passed via `data.entry`. The runner generates an in-memory wrapper module (passed as `script` to Miniflare, no temp files) that imports the user entry and adds IPC glue. `scriptPath` is set to the entry's directory so workerd resolves relative imports correctly.

**Request handling (#50):** The generated wrapper (`src/runners/miniflare/wrapper.ts`) mirrors srvx's `CloudflareServer` inline (no `srvx` import inside workerd, so no module-resolution or `transformRequest` dependency): `__createServer(entry)` runs `entry.plugins` against a server-like object (`runtime: "cloudflare"`, `options`), unshifts the `entry.error` handler as the outermost middleware, then composes `options.middleware` around `options.fetch`. Per request, `server.fetch(request, env, ctx)` defines `request.waitUntil`, `request.runtime = { name: "cloudflare", cloudflare: { env, context } }` and an `ip` getter (`cf-connecting-ip`), exactly like `srvx/cloudflare`, then calls the chain; the terminal handler invokes `entry.fetch(request, env, ctx)` (env/ctx read back from `request.runtime`) so Workers-style entries keep working. The `env` exposed to the entry (both arguments and `request.runtime`, plus the crossws upgrade adapter) is a per-env-object cached (`WeakMap`) shallow copy without the internal `__ENV_RUNNER_IPC` (`IPC_BINDING`) and `__ENV_RUNNER_UNSAFE_EVAL__` (`UNSAFE_EVAL_BINDING`) bindings; the wrapper itself keeps using the raw env for IPC and reloads. The server is (re)built whenever the entry is loaded, including `reloadModule()` — before the old entry's `ipc.onClose()`, so a throwing plugin reports a reload error without tearing down the old entry. `captureErrors` wraps `server.fetch`, so it only sees errors the entry's `error` handler didn't handle. Durable Object / Entrypoint classes still receive workerd's raw `env`.

**Module resolution:** Uses `unsafeModuleFallbackService` + `unsafeUseModuleFallbackService` to resolve imports that workerd can't find on its own (e.g. imports from `node_modules`, parent directories, or cache-busted reload imports). The fallback serves `data.virtual` keys first (virtual overrides disk and `transformRequest`), then reads files from disk relative to the entry directory. Supports cache-busting query strings (`?t=<version>`) for hot-reload. See "Virtual modules" above for the miniflare-specific virtual module details and caveats.

**Module transform pipeline:** Optional `transformRequest` callback enables integration with Vite's (or any) transform pipeline. When provided, `unsafeModuleFallbackService` calls it with the resolved file path before falling back to raw disk reads. Returns `{ code: string }` or null. This enables TS/JSX/etc. compilation on-the-fly without pre-bundling. When `transformRequest` is set, the wrapper skips static `export *` re-exports (uses `dynamicOnly` mode) to avoid miniflare's ModuleLocator pre-walking the import tree, and adds `modulesRules` for `.ts`/`.tsx`/`.jsx`/`.mts` extensions.

**IPC:** Full bidirectional IPC (`ipc.onOpen`, `ipc.onMessage`, `ipc.onClose`) via a persistent WebSocket pair. During init, `dispatchFetch` with `upgrade: "websocket"` establishes a `WebSocketPair` — the runner keeps the client end, the worker wrapper keeps the server end. All messaging (user messages, reload commands, shutdown) flows over this single persistent connection as JSON. No per-message `dispatchFetch` overhead.

**Hot-reload:** `reloadModule()` sends `{ type: "reload", version }` over the WebSocket. The worker wrapper uses `unsafeEvalBinding` (`__ENV_RUNNER_UNSAFE_EVAL__`) to create a dynamic `import()` with a cache-busting query string. The module fallback service serves the fresh file from disk. Old entry's `ipc.onClose()` is called before swapping, new entry's `ipc.onOpen()` is called after. Worker sends `{ event: "module-reloaded" }` back over the WebSocket when done.

**Wrangler config:** The `wrangler` option loads a Cloudflare Wrangler config into Miniflare options; `wranglerEnv` selects a `--env` (defaulting to the `CLOUDFLARE_ENV` env var. It accepts `true` (auto-discover `wrangler.{json,jsonc,toml}` next to the entry then in cwd), a string config path, **or an inline raw (snake_case) config object** (`WranglerInlineConfig`, discriminated by `isInlineWranglerConfig()`). `wranglerConfigPath` (a separate runner option — not a key inside the inline object, which stays raw wrangler config) replaces auto-discovery for `true` and inline configs (resolved from cwd); a missing file warns and aborts for `true`, but an inline config continues alone. A string `wrangler` path wins over `wranglerConfigPath` (which is then ignored), and `wranglerConfigPath` does nothing while `wrangler` is disabled. An inline object is **not** mutually exclusive with a file: `loadWranglerConfig()` still loads a config file (`wranglerConfigPath` or auto-discovered) and `mergeWranglerMiniflareOptions()` merges the inline-derived options on top of the file-derived ones (inline wins per key, binding records shallow-merge, array options like `compatibilityFlags` union). `loadWranglerConfig()` runs in `#initAsync` before the options literal is built and its result is spread **under** `miniflareOptions` (so user options win; `compatibilityFlags` are unioned with `nodejs_compat` + user flags). After the spread, nested record options shared by `wranglerOptions` and `miniflareOptions` (e.g. `bindings`) are **shallow-merged per key** (`isPlainObject` check) so user `miniflareOptions.bindings` extend wrangler-derived bindings instead of replacing the whole object (user keys still win on conflict). Resolution is two-tier. It first uses the `wrangler` package — the caller-supplied `wranglerModule` (imported module or specifier) when present, otherwise the shared `resolveRuntimeDep()`'s optional import of `wrangler` — `unstable_readConfig({ config, env }, { hideWarnings: true })` then `unstable_getMiniflareWorkerOptions(config, env)`, keeping the resulting `workerOptions` (`pickWranglerMiniflareOptions()`) minus a **droplist** of options a single fetch-only dev worker can't run (`assets`, `serviceBindings`, `workflows`, `queueConsumers`, `tails`, `streamingTails` — they point at other workers or need an asset router/queue/workflow engine, and make workerd refuse to start; users opt back in via `miniflareOptions`), `durableObjects` entries with a `scriptName` (wrangler's shape is `{ className, scriptName, useSQLite, container }`; bindings to another script can't resolve — `filterLocalDurableObjects()`; `additionalUnboundDurableObjects` is kept), empty records/arrays (wrangler returns `{}`/`[]` for every unused binding type), and a denylist of runner-owned keys (`script`/`scriptPath`/`modules`/`modulesRoot`/`modulesRules`/`unsafeDirectSockets`/`unsafeEvalBinding`/`unsafe*ModuleFallbackService`/`name`; `modulesRules` is denied because `unstable_getMiniflareWorkerOptions` always returns default rules and the runner owns module loading via the fallback service + `dynamicOnly` wrapper. **Dropped-option warning:** every non-empty droplisted option and every external-script DO binding is recorded in a per-load `DroppedWranglerOptions` map (wrangler config key → set of binding names: record keys, array entries' `name`, `assets.binding`; DOs as `NAME → script "other"`), shared by the file and inline reads so duplicates collapse, and `warnDroppedWranglerOptions()` emits **one** `console.warn` (`[env-runner] wrangler config options not supported by the miniflare dev runner were ignored: services (MY_SERVICE), ...; pass them via miniflareOptions to opt in.`) — nothing for wrangler's `{}`/`[]` placeholders. User `miniflareOptions` never pass through the droplist, so they never warn. **Source isolation:** on the real-package path the file and inline configs are read in separate `try` blocks, each warning `failed to load wrangler config "<path>"` / `(inline)` on its own; `configFile` is only reported when the file read succeeded. An **inline** object is normalized through `readInlineWranglerConfig()`, which writes it to a short-lived temp file (`mkdtemp` in `os.tmpdir()`, removed in `finally`) because `unstable_readConfig` is file-based — `unstable_getMiniflareWorkerOptions` rejects a raw, un-normalized object; env-runner ignores the config's `main`, so the temp location's relative resolution is irrelevant. `readConfig` throws for an `--env` missing from the config's `env` map, so when the inline config doesn't define the selected env it is read with its `env` key stripped and no env (top level as-is — `applyWranglerEnv()` semantics), letting the file's env still apply. When no `wrangler` package is available (or `wranglerModule: false` was passed, or the module lacks the `unstable_*` helpers), it falls back to a built-in minimal reader: files via `readWranglerConfigMinimal()` (plain JSON only — `JSON.parse`; JSONC and TOML files are skipped with a warning, since `wrangler` is needed to parse them), inline objects directly; both then run `applyWranglerEnv()` (shallow `--env` override) and `mapWranglerConfigToMiniflare()`, which maps the common snake_case fields to Miniflare shapes (`compatibility_date`/`compatibility_flags`, `vars`→`bindings`, `kv_namespaces`/`r2_buckets`/`d1_databases`/`queues.producers`→records, `durable_objects.bindings`→`durableObjects`, skipping entries with `script_name`), and the file- and inline-derived results are merged the same way. The minimal mapper never maps services/assets/queue consumers/workflows/tails, but for warning parity it reports raw `services`, `assets`, `queues.consumers`, `workflows`, `tail_consumers`, `streaming_tail_consumers` keys and skipped `script_name` DOs into the same dropped map. **Persist root:** whenever `wrangler` is enabled (`true`, string path, or inline object — regardless of whether a file loaded), the runner defaults Miniflare's shared `defaultPersistRoot` to `<dir>/.wrangler/state/v3` (what `wrangler dev` uses, so state is shared) via `wranglerPersistRoot()` in `runner.ts`; `<dir>` is `dirname(configFile)` when `loadWranglerConfig()` reports a loaded file (real or minimal path), else the dir of the explicit path (`wrangler` string or `wranglerConfigPath`, resolved from cwd, even if missing), else `process.cwd()` (where `wrangler dev` runs; covers inline-only configs and `wrangler: true` with nothing discovered) — placed before the `wranglerOptions`/`miniflareOptions` spreads and skipped entirely when `miniflareOptions` has `defaultPersistRoot` or any `*Persist` key (`hasUserPersistOptions()`). **DO auto-wiring** merges with wrangler/user DO bindings: detected exports are added as `SCREAMING_SNAKE` bindings unless the binding name is taken or the class is already bound by a local binding (string or object without `scriptName`); previously any `options.durableObjects` (including wrangler's always-present `{}`) disabled auto-wiring. Auto-discovery still lists `wrangler.jsonc` (the real `wrangler` parses it; the minimal reader skips it). `wrangler` is **not a dependency** — it reaches the runner through `wranglerModule` (imported module or specifier) or the optional import. Out of scope: `main` is not used as the entry (env-runner takes `data.entry` explicitly), and esbuild `define`s are ignored.

## Testing

- **`test/miniflare.test.ts`** — Tests for `MiniflareEnvRunner`: Durable Object exports, IPC alongside custom exports, hot-reload via `reloadModule()`, IPC re-initialization after reload, and the explicit `miniflare` dependency (a subclassed `Miniflare` proves the passed module is the one instantiated; omitting the option still works via the optional import; a module without a `Miniflare` export closes the runner with a clear error). Every construction passes `miniflare` (imported at the top of the file)
- **`test/wrangler.test.ts`** — Tests `MiniflareEnvRunner`'s `wrangler` option, both backends in one file via two matrix-driven `describe` blocks sharing a `WranglerCase`/`runWranglerCase()`/`defineWranglerCases()` harness. The harness passes a capturing `Miniflare` subclass so `assert(json, { tmpDir, entryPath, mfOptions })` can inspect the constructor options, spies `console.warn` in both backends (`WranglerCase.warns`), and creates parent dirs for nested `files`. **`SHARED_CASES`** run against both backends: inline config + `wranglerConfigPath` merge (config in a subdir, no chdir), `wranglerConfigPath` with `wrangler: true`, a missing `wranglerConfigPath` warning while the inline config still applies, `compatibilityDate: "latest"` overriding a wrangler date, `miniflareOptions.compatibilityDate` winning over it, clamping a `2999-01-01` wrangler date (worker still serves + warning), dropping an external-script DO binding while merging auto-wired exports (`LOCAL`→`Counter` from wrangler, `GREETER` auto-wired, no duplicate `COUNTER`), a file declaring `services`/`assets`/`queues.consumers`/`workflows`/`tail_consumers` still starting and serving with those keys absent from the Miniflare options plus exactly one dropped-option warning naming `services (OTHER_SERVICE)` etc. (the external-DO case likewise asserts one warning naming `EXTERNAL → script "other-worker"`, and a plain `wranglerConfigPath` config asserts no such warning), the same service declared in both file and inline configs producing one deduped warning, an inline config with `env: { prod }` over a file with `env.test` + `wranglerEnv: "test"` yielding the file env var and the inline top-level var with no "failed to load" warning, and the persist-root default (`defaultPersistRoot` = `<tmpDir>/.wrangler/state/v3` with a KV write creating `kv/` under it; not set when `miniflareOptions.kvPersist` is passed; `<cwd>/.wrangler/state/v3` for an inline-only config and for `wrangler: true` with no file found; `<tmpDir>/config/.wrangler/state/v3` for a missing `wranglerConfigPath` + inline config). Test temp dirs live under `test/.tmp-wrangler-*` (gitignored via `**/.tmp-*`) and are removed after each test. Because Miniflare creates persist dirs eagerly (e.g. `cache/`), the capturing `Miniflare` subclass records the original options but strips a `defaultPersistRoot` outside the temp dir before calling `super()` — cwd-anchored cases assert on the captured options only, so no `.wrangler/` state lands in the repo root. **Installed `wrangler` package:** loading `vars` from a `wrangler.jsonc` (explicit path), auto-discovery next to the entry (`wrangler: true`), `--env` selection (`wranglerEnv`), `--env` defaulting from the `CLOUDFLARE_ENV` variable, an **inline config object** (plus inline `--env`), an **inline config merged on top of an auto-discovered file** (inline wins per key, other file keys preserved), `transformRequest` coexisting with a wrangler config (the runner keeps its own TS module rules — wrangler-derived `modulesRules` are denylisted), and `miniflareOptions.bindings` merging with (and winning over) wrangler `vars` per key, and a broken inline config (`vars: "not-an-object"`, rejected by `readConfig`) warning `(inline)` while file bindings and the file-anchored persist root survive. `WranglerCase.assertWarnings(warnings)` gives cases custom assertions over all captured warnings (`droppedWarnings()` filters the ignored-options ones). **Built-in minimal reader** (second `describe`, which passes `wranglerModule: false` — no module mocking needed now that the package is an explicit option; the `WranglerCase.withWrangler` flag picks `wrangler` vs `false` per case, and omitting the option is _not_ usable here because the optional import would resolve the installed package): plain-JSON `vars` reach the worker, an **inline config object** maps via the minimal mapper, non-`vars` bindings (`kv_namespaces`) map to a real binding, and JSONC/TOML files are skipped with a warning. A dedicated case passes `wranglerModule: "wrangler"` (`WranglerCase.wranglerSpecifier`) and parses a JSONC config, proving the specifier form reaches the real package. (Configs pin a `compatibility_date` so workerd accepts them regardless of the system clock.)
- **`test/miniflare.test.ts` › srvx cloudflare context** — `test/fixtures/worker-srvx.mjs` asserts `request.runtime`/`ip`/`waitUntil`, that `env` (argument and `request.runtime.cloudflare.env`) contains only user bindings, and that `middleware`, `plugins` (response-header decoration — workerd request headers are immutable) and `error` are applied
- Test fixture in `test/fixtures/worker-do.mjs` — Worker with Durable Object export + IPC for miniflare tests

> Virtual modules on miniflare are tested in `test/virtual.test.ts` — see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md).
