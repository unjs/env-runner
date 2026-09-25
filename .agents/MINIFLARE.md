# Miniflare Internals & Patterns

General Miniflare/workerd API facts (external knowledge, not env-runner specific).

## Worker script modes (mutually exclusive)

- **`modules: [{ type, path, contents? }]`** — in-memory; `contents` falls back to reading `path`. Module name inside workerd = `path.relative(modulesRoot, path)`; `modulesRoot` defaults to cwd.
- **`script` + `scriptPath` + `modules: true`** — inline source; `scriptPath` is never read, it only anchors relative imports and stack traces. **env-runner uses this.**
- **`scriptPath` only** — file on disk.

## `unsafeEvalBinding: "NAME"`

Exposes workerd's `UnsafeEval` as `env.NAME`: `eval(code, name?)`, `newFunction(script, name?, ...args)`, `newAsyncFunction(...)`.

- Cannot run ESM `import`/`export` declarations — only statements/expressions. Get a dynamic importer via `newAsyncFunction("return await import(path)", "loader", "path")`.
- Hot-reload = re-import with a cache-busting query (`?t=<version>`).

## `unsafeModuleFallbackService`

Shared (top-level) callback invoked when workerd can't resolve an import; each worker opts in with `unsafeUseModuleFallbackService: true`.

- Request: `?specifier=` (resolved absolute path), `?rawSpecifier=` (as written), `?referrer=`; header `X-Resolve-Method: import | require`.
- Response: JSON `{ name, esModule | commonJsModule | text | data | wasm | json }` (`data`/`wasm` as number arrays). `name` must be relative (no leading `/`) — it is the module identity.
- `404` → not found (workerd falls back to built-ins like `node:`/`cloudflare:`); `301` + `Location` → redirect.
- workerd caches modules by name: strip `?t=` when reading from disk but keep it in `name` so a reload is a new module.
- `specifier` is `rawSpecifier` joined onto the referrer's name as **plain text**: no percent-decoding (`./a%20b.mjs` stays `%20`), and a `file:` URL is joined like a relative path (`/dir/file:/x.mjs`). Only `rawSpecifier` keeps the URL intact.
- **Redirects** (verified on v4 and v5): workerd re-requests with the `Location` verbatim as `specifier` (`rawSpecifier`/`referrer` unchanged), and the `name` must match it. Header bytes are read as UTF-8, so send a non-ASCII location as latin1-encoded UTF-8 (`Buffer.from(loc, "utf8").toString("latin1")`). A redirect loop crashes workerd (segfault).
- Static imports of the main module that no worker module provides go through the fallback at startup (v5, or v4 with a `modules` list).

## Service bindings

- `serviceBindings: { NAME: async (request) => Response }` — runs in Node; worker calls `env.NAME.fetch(url)`.
- `serviceBindings: { NAME: { node: (req, res) => {} } }` — bridges to a raw Node HTTP handler.

## Singleton Durable Objects

`durableObjects: { X: { className, unsafeUniqueKey: kUnsafeEphemeralUniqueKey, unsafePreventEviction: true } }` — fixed key yields one instance that is never evicted (holds WebSockets, module caches, etc.).

## `@cloudflare/vite-plugin` (reference)

- Wrapper entry → a runner DO holding a Vite `ModuleRunner` + WebSocket to the dev server; Vite-transformed code is executed via `unsafeEval`. HMR re-evaluates without restarting Miniflare.
- Internal bindings (`__VITE_RUNNER_OBJECT__`, `__VITE_INVOKE_MODULE__`, `__VITE_UNSAFE_EVAL__`, `__VITE_MIDDLEWARE__`, ...) are stripped from the user `env`.
- `modulesRoot: "/"` (`"Z:\\"` on Windows) makes module names = absolute paths minus the leading `/`. The fallback service handles `.wasm`/`.bin`/`.txt`/`.html`/`.sql` via marker strings.
- When exports change (e.g. a new DO class) it restarts the whole dev server, since the wrapper's export declarations are baked into worker options.

---

# env-runner `MiniflareEnvRunner`

Overview lives in [`../AGENTS.md`](../AGENTS.md); virtual modules on miniflare in [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md). Source: `src/runners/miniflare/{runner,wrapper,wrangler}.ts`.

## Runtime

- **No proxy/worker file** — `fetch()` calls `mf.dispatchFetch()`. The wrapper is passed as in-memory `script` with `scriptPath` = `<entryDir>/__env_runner_wrapper.mjs` and `modulesRoot: "/"` (as a `modules` list for a virtual entry with exports on v4, see below).
- **`miniflare` dependency** — resolved via `resolveRuntimeDep(..., { required: true })`; async init errors are logged and `close(error)` the runner.
- **miniflare v4 and v5** — options are always built in the v4 format (what wrangler's `unstable_getMiniflareWorkerOptions` returns). When the module exports `convertV4MiniflareOptions` (v5), `toMiniflareOptions()` converts them, mapping `defaultPersistRoot` → `resourcePersistencePath` (the converter drops it; per-plugin `*Persist` options are dropped too). v5 rejects `modulesRules` and has no ModuleLocator, so the `transformRequest` rules are v4-only. v5 no longer exports `supportedCompatibilityDate`: `resolveSupportedCompatibilityDate()` reads `workerd`'s `compatibilityDate` (resolved via miniflare from cwd, then env-runner) and clamps it to today like v4.
- **Compatibility date** — first defined of `miniflareOptions.compatibilityDate` > runner `compatibilityDate` (`"latest"` → `supportedCompatibilityDate`) > wrangler date > `supportedCompatibilityDate`. Never "today": the workerd binary lags the calendar and refuses future dates. Any date newer than the installed workerd is clamped with a warning, whatever its source (mirrors `wrangler dev`).
- **`nodejs_compat`** — added by default, but omitted when either user or wrangler flags contain `no_nodejs_compat` (workerd rejects contradictory flags; user flags win the pair). Without it the wrapper also skips its `node:process` import, which would not resolve.
- **Module resolution** — the fallback service serves `data.virtual` keys first (verbatim, or path keys by path with `file:` imports redirected; see [`VIRTUAL-MODULES.md`](VIRTUAL-MODULES.md)), then `transformRequest` (`{ code } | null`), then disk. The wrapper is always generated `dynamicOnly` (no static `export *` of the entry) so Miniflare's ModuleLocator doesn't pre-walk the entry's import tree; with `transformRequest` on v4, `.ts/.tsx/.jsx/.mts` `modulesRules` are added so the locator doesn't reject them. The wrapper only imports statically when it re-exports named exports (see below), and those cases bypass the locator with an explicit `modules` array.
- **Exports / DO auto-wiring** (`exports`, on by default; `false` disables) — `export class` names detected in the entry (merged with a record) become `SCREAMING_SNAKE` DO bindings unless the name is taken or the class is already bound locally (string or object without `scriptName`), merging with wrangler/user bindings. A string (absolute path or virtual key; relative paths resolve from the entry's directory) is re-exported with `export *` instead: no detection or auto-binding, and the entry's own classes are not re-exported, so bindings come from wrangler/`miniflareOptions`. Exports are baked in at startup: recreate the runner when classes change (`reloadModule()` only reloads the entry). DO/Entrypoint classes receive workerd's raw `env`.
  - A string, or named exports with a virtual entry, gets the wrapper as `modules: [{ type: "ESModule", path: scriptPath, contents }]` instead of `script` (no v4 locator, no `modulesRules`), so the fallback serves the static re-exports at startup.
  - A real entry with detected exports keeps `script`, so v4's locator walks its static graph on disk and its static imports of virtual modules fail (`ERR_MODULE_RULE`). A module list would fix that, but it would also drop what the locator handles by `modulesRules` (`.wasm`/text/data modules), which the fallback can't serve. v5 has no locator.
- **IPC** — during init a `dispatchFetch` with `upgrade: "websocket"` creates a persistent WebSocket pair carrying all JSON messages (user messages, reload, shutdown). A WebSocket from one request context can't be used from another in workerd, so once a user request was seen the wrapper keeps its raw `env` (never cleared: requests overlap and streamed bodies outlive `fetch`) and worker → host messages go through the `__ENV_RUNNER_IPC` service binding instead. With `persistent`, the binding is retargeted to the runner that attached last.
- **Hot reload** — `reloadModule()` sends `{ type: "reload", version }`; the wrapper re-imports the entry via `__ENV_RUNNER_UNSAFE_EVAL__` with `?t=<version>`, rebuilds the server, calls old `ipc.onClose()` then new `ipc.onOpen()`, and replies `{ event: "module-reloaded" }`. The server is rebuilt _before_ the old `onClose()`, so a throwing plugin reports a reload error without tearing down the old entry.

## Request handling (wrapper)

- Mirrors `srvx/cloudflare`'s `CloudflareServer` inline — **no `srvx` import inside workerd**, so it doesn't depend on module resolution or `transformRequest`.
- Applies `entry.plugins`, `entry.error` (outermost middleware), `entry.middleware`; adds `request.runtime = { name: "cloudflare", cloudflare: { env, context } }`, `request.ip` (`cf-connecting-ip`), `request.waitUntil`. The terminal handler still calls `entry.fetch(request, env, ctx)` for Workers-style entries.
- The entry-visible `env` (args, `request.runtime`, crossws adapter) is a `WeakMap`-cached shallow copy without `__ENV_RUNNER_IPC`/`__ENV_RUNNER_UNSAFE_EVAL__`; the wrapper keeps the raw env.
- `captureErrors` wraps `server.fetch`, so it only sees errors the entry's `error` handler didn't handle.

## Wrangler config

`wrangler: true | "<path>" | <inline raw snake_case config>`, plus `wranglerConfigPath`, `wranglerEnv` (default `CLOUDFLARE_ENV`), `wranglerEnvFiles`, `wranglerModule`. Result is spread **under** `miniflareOptions` (user wins); plain-object options like `bindings` are shallow-merged per key so user bindings extend wrangler ones.

### Sources

- `wranglerConfigPath` replaces auto-discovery for `true`/inline; a string `wrangler` path wins over it; it does nothing while `wrangler` is off. Missing file: warns and aborts for `true`, inline continues alone.
- **Inline + file are merged**, not exclusive: inline wins per key, binding records shallow-merge, arrays (`compatibilityFlags`) union. File and inline are read in separate `try` blocks — one failing warns (`"<path>"` / `(inline)`) without discarding the other.
- **Inline configs go through a temp file** (`mkdtemp`, removed in `finally`): `unstable_readConfig` is file-based and `unstable_getMiniflareWorkerOptions` rejects un-normalized objects. Relative `wasm_modules`/`text_blobs`/`data_blobs` in inline configs therefore resolve into the temp dir (not addressed).
- `readConfig` throws for an `--env` missing from `env`, so an inline config lacking the selected env is read without `env` (top level as-is), letting the file's env still apply.
- `main` is ignored (entry comes from `data.entry`); esbuild `define`s are ignored.

### Auto-discovery (`wrangler: true`)

- Entry dir inside cwd → walk up from the entry dir. Otherwise → check only the entry's own dir, then walk up from cwd. So an ancestor of an out-of-cwd entry (pnpm-hoisted framework entry, sibling package) never beats cwd's config, keeping the persist root stable.
- Nearest dir wins; within a dir `wrangler.json` > `wrangler.jsonc` > `wrangler.toml`. Deliberately deviates from wrangler (script dir _or_ cwd, each filename searched fully before the next).
- A hit above the entry dir/cwd is `console.info`'d once per path per process.

### Option filtering

- **Droplist** (`assets`, `serviceBindings`, `queueConsumers`, `workflows`, `tails`, `streamingTails`) — they point at other workers or need an asset router/queue/workflow engine, and make workerd refuse to start for a single fetch-only dev worker. Users can opt back in via `miniflareOptions` (never filtered or warned).
- **External-script DO bindings** (`scriptName` set) are dropped — they can't resolve. Exception: `scriptName` equal to the effective worker name is _this_ worker (matches wrangler's `partitionDurableObjectBindings`), kept with `scriptName` stripped (other fields like `useSQLite` preserved). Effective name = inline `name` ?? file `name`; with an env selected, `env.<env>.name` else `<name>-<env>` (even if the env section is missing). Filtering runs on the merged file + inline options.
- **Denylist** of runner-owned keys (`script*`, `modules*`, `unsafeEvalBinding`, `unsafe*ModuleFallbackService`, `unsafeDirectSockets`, `name`). `modulesRules` is denied because wrangler always returns default rules while the runner owns module loading (fallback service + `dynamicOnly` wrapper) and its own TS rules.
- **Empty placeholders** — wrangler returns `{}`/`[]` for every unused binding type and always `email: { send_email: [] }`; those (and wrappers whose values are all `[]`) are skipped so they don't shallow-merge over a populated file value. `{}` values (`workerLoaders: { LOADER: {} }`) and `[]` JSON vars are kept.
- **One dropped-option warning per load** naming config key + binding names (DOs as `NAME → script "x"`), deduped across file + inline; nothing for placeholders. The minimal reader reports the raw keys too, for parity.

### Dev vars / secrets (wrangler package)

- The inline read's `userConfigPath` is re-anchored to the config file (if it exists, even if it failed to load; else cwd) so wrangler's `getVarsForDev` loads `.dev.vars`/`.dev.vars.<env>`/`.env*` for the inline part too; the selected `env` is passed there for the lookup.
- `.dev.vars` beats `vars` within each read, so inline `vars` can't override file dev-var secrets.
- If the file declares `secrets` and the inline config doesn't, the inline read uses the file's `secrets` (only declared keys + `process.env`), and inline dev-var bindings are filtered to those declared inline or produced by the file read — otherwise `.dev.vars` keys the file excluded (or names of other binding types) would leak back in.
- **`wranglerEnvFiles`** → `envFiles` for both reads; paths resolve against the config file's dir (inline: re-anchored file, else cwd). Non-empty: skips `.dev.vars`, loads the listed `.env` files (later wins). `[]`: reads `.dev.vars` but no `.env*`.
- Known noise: wrangler hard-codes `silent: false`, so `Using secrets defined in .dev.vars` logs once per read (twice for file + inline, again each re-init). Silencing it would require overriding wrangler's global logger level — left as is.

### Wrangler warnings

- Config files: `hideWarnings` is false only the first time per resolved path + env + mtime/size per process, so wrangler's diagnostics (unexpected keys, `No environment found ...`) print once per file version instead of every re-init/hot reload. Unexpected keys also trigger wrangler's npm update check.
- Inline configs always use `hideWarnings: true`: the header would name the throwaway temp file and they are re-normalized on every load. Validation errors still throw → `(inline)` warning.

### Minimal reader (no `wrangler` package, or `wranglerModule: false`)

Mirrors wrangler (`normalizeAndValidateEnvironment`, `convertConfigToBindings({ usePreviewIds: true })`, `getDurableObjectClassNameToUseSQLiteMap`, `getVarsForDev`) for the fields it maps; `test/wrangler.test.ts` "matches wrangler semantics" runs the same assertions on both backends.

- JSON/JSONC files (`parseJSONC()`: comments + trailing commas, both extensions, like wrangler); TOML is skipped with a warning.
- **`--env`** — `WRANGLER_NON_INHERITABLE_KEYS` (bindings, `vars`, `secrets`, ...) are not inherited from the top level; other fields (`compatibility_*`, `migrations`, `exports`) are. A file whose `env` map lacks the selected env fails to load (`failed to load wrangler config`); with no `env` map the top level applies. File-only wrangler-style warnings (non-inherited top-level keys, missing env) share `claimWranglerWarnings()` dedupe. Inline configs lacking the env use their top level (as in the package path).
- Maps `compatibility_*`, `vars` → `bindings`, KV/R2/D1 (preview id → id → binding name), `queues.producers`, `durable_objects.bindings` → `{ className, scriptName?, useSQLite? }` (same `script_name` filtering), and migrated classes without a binding → `additionalUnboundDurableObjects`.
- **Dev vars** (`dotenv.ts`: `util.parseEnv` + a `dotenv-expand` port) — loaded once for the merged file + inline result from the config file's dir (else cwd), honoring `wranglerEnvFiles`, `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV`, `CLOUDFLARE_INCLUDE_PROCESS_ENV`. `.dev.vars` beats `vars`; names of KV/R2/D1/queue/DO bindings are never replaced. If either config declares `secrets`, only declared vars + `secrets.required` keys are taken (and `process.env` is included); missing required secrets warn.
- Other binding keys (`MINIMAL_UNSUPPORTED_BINDING_KEYS`: `hyperdrive`, `ai`, `ratelimits`, `wasm_modules`, ...) are ignored with one warning suggesting `wrangler`, deduped across file + inline.

### Persist root

Enabling `wrangler` (any form, whether or not a file loaded) defaults `defaultPersistRoot` to `<dir>/.wrangler/state/v3` — what `wrangler dev` uses, so state is shared. `<dir>` = loaded config file's dir, else the requested path's dir (even if missing), else cwd. Skipped when `miniflareOptions` sets `defaultPersistRoot`, `resourcePersistencePath` (v5) or any `*Persist` key.

## Testing

- `test/miniflare.test.ts` — DO exports, IPC (incl. overlapping/streamed requests, `test/fixtures/worker-ipc-requests.mjs`), `reloadModule()`, explicit `miniflare` option, srvx cloudflare context (`test/fixtures/worker-srvx.mjs`; response headers are decorated because workerd request headers are immutable). `test/miniflare-request.test.ts` — `dispatchFetch` request fidelity. Virtual modules → `test/virtual.test.ts`.
- `test/wrangler.test.ts` — matrix over both backends (package / minimal reader) capturing the runner-built (v4-format) options (`capturingMiniflare()`: wraps `convertV4MiniflareOptions` on v5, subclasses `Miniflare` on v4), plus a fast `loadWranglerConfig()`-only block (discovery, self-referencing DOs, warnings dedupe, dev vars/`envFiles`, `no_nodejs_compat`).
- Gotchas:
  - Minimal-reader cases must pass `wranglerModule: false` — omitting it would optional-import the installed `wrangler`.
  - Miniflare creates persist dirs eagerly, so the capture strips a persist root (`defaultPersistRoot`/`resourcePersistencePath`) outside the temp dir; cwd-anchored cases assert on captured options only (no `.wrangler/` in the repo root).
  - Configs pin `compatibility_date` so workerd accepts them regardless of the clock.
- The devDependency is miniflare v5. To check v4, alias `miniflare` to a v4 install in a throwaway Vitest config (`resolve.alias`) and run the miniflare/wrangler/virtual suites; specifier/omitted-`miniflare` cases still load v5.
  - `process.cwd` is mocked via `vi.spyOn` (no `chdir`); inline-only loads also pass a missing `configPath` so host ancestor `wrangler.*` files can't interfere, and the "none found" case `ctx.skip()`s if any ancestor has one.
  - Temp dirs live under `test/.tmp-wrangler-*` (gitignored via `**/.tmp-*`).
