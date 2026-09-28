# Plugins (`data.plugins`)

Host-side `transform` plugins for the entry, its disk imports and virtual modules. User docs: README "Plugins (`data.plugins`)".

- **`src/common/plugins.ts`** (host) — public types (`EnvRunnerPlugin`, `PluginTransformFilter`, ...), `createPluginPipeline()` (validation, `pre`/normal/`post` ordering, full filters, async handlers, source maps, "still not JS" error) and `transformVirtualModules()`
- **`src/common/plugin-filter.ts`** (shared) — candidates (`isTransformCandidate()`: script extension, no `/node_modules/`), `moduleTypeOf()`, `id` matching (globs via `path.matchesGlob`, relative ones resolved from cwd), serialized prefilters (`createPrefilter()`: globs pre-resolved on the host, RegExps as `{ source, flags }`)
- **`src/common/transform-channel.ts`** — the sync request channel (host `openTransformPort()`/`openTransformSocket()`, worker `createTransformClient()`)
- **`src/common/plugin-hooks.ts`** (worker) — `registerPluginHooks()`, `transformedFormat()`, `createBunFilter()`, `servedByPluginHooks()` (Bun reloads)

## Flow

1. `BaseEnvRunner` constructor: `createPluginPipeline(data.plugins)` (throws `TypeError` for invalid plugins) into `_plugins`; `plugins` is removed from `_data`, which is sent to the worker.
2. Virtual modules: `_resolveVirtualData()` takes the async path when there are plugins (resolve factories → `transformVirtualModules()`), and `_enqueueVirtualUpdate()` transforms the resolved changes before storing and sending them. `_virtualSources` keeps the originals, so `invalidateModule()` re-transforms. Output format: `commonjs` for CommonJS formats, else `module`.
3. `_pluginWorkerData(kind)` adds `data.__envRunnerPlugins = { prefilters, ...channel }` (`PLUGINS_DATA_KEY`) and opens the channel once (`_transformChannel`, closed in `close()`): `"port"` from `NodeWorkerEnvRunner.#initWorker()` (the port goes in `transferList`), `"socket"` from `_processEnv()` (so every process runner gets it through the init-data JSON).
4. Workers call `registerWorkerHooks(data)` (`worker-utils.ts`): `registerPluginHooks()` first, then `registerVirtualModules()`. Later `registerHooks` registrations run first, so virtual keys are served before the plugin hook sees them (their sources are already transformed).
5. A load of a candidate the prefilter matches reads the file, sends `{ id, path, code }`, and blocks for `{ id, code? }` (no `code`: unchanged, fall through to `nextLoad()` / Bun's native loader) or `{ id, error }` (thrown from the load).

## Transport

Loader hooks are synchronous (`registerHooks`, and Bun's `onLoad` under `require`), so the worker blocks with `Atomics.wait` on a shared `Int32Array` counter and reads the reply with `receiveMessageOnPort()`. The runner IPC channel can't carry the reply: its listener runs on the blocked thread. Async hooks aren't an option either: Deno and Bun have no `module.register()`, and Node's off-thread hooks deadlock on `require`.

- **node-worker** (and vercel/netlify): a `MessageChannel` + `SharedArrayBuffer` created by the runner. The runner's port answers directly (`port1.unref()`, closed with the runner), then bumps and notifies the counter.
- **Process workers**: the runner listens on a fresh local socket (`$TMPDIR/env-runner-<pid>-<rand>.sock`, falling back to `/tmp` for long paths; `\\.\pipe\env-runner-...` on Windows). Binding is synchronous, so the path is in the init data before the worker can connect. The worker starts an eval helper `Worker` (CommonJS source string, no extra dist file; eval workers work on Node, Deno and Bun) that connects and relays newline-delimited JSON between the socket and a `MessagePort`, notifying the counter per reply. The helper is `unref()`d. When the socket closes, it answers every request with `{ closed: true, error }`, so a blocked load throws instead of hanging.
- Requests are sequential (one blocked thread), so a reply with a different `id` is stale and skipped.
- Verified on Node 24, Deno 2.9.6 and Bun 1.4.2 (`Atomics.wait` on the main thread, `SharedArrayBuffer` in `workerData`, eval workers, `node:net` unix sockets from a worker thread).

## Per runtime

- **Node/Deno** (`registerHooks`): `file:` URLs only (query stripped). Output format via `transformedFormat()`: the resolution hint when definite (`module*`/`commonjs*`), then `.m*`/`.c*` extensions, then CommonJS markers + no ESM syntax (es-module-lexer). Deno evaluates hook output as ESM, so CommonJS output falls through to `nextLoad()` (Deno's native loader, `--unstable-detect-cjs` for CommonJS `.ts`).
- **Bun** (`Bun.plugin` `onLoad`, can't be removed): one filter RegExp from `createBunFilter(prefilters)`: one alternative per plugin with the extensions its `moduleType` implies (never `.cjs`/`.cts`), RegExp `id` excludes as negative lookaheads and all-RegExp includes as lookaheads (not folded when flags differ or a source has backreferences/named groups), `/node_modules/` excluded. Paths the RegExp passes but the prefilter doesn't are served with Bun's native loader. Output is always ESM, so CommonJS in covered files is unsupported. `_importFresh()` evicts `require.cache` for plugin-served entries (Bun drops the query).
- **Miniflare**: no channel. The module fallback service runs `_plugins.transform()` on disk modules `transformRequest` returned no code for; CommonJS output (`transformedFormat()`) goes behind the ESM shim. Errors are logged on the host and served as a module that throws (a named import fails at link time first, hiding the message from workerd). v4 adds `.cts` to the `modulesRules` it adds for `.ts`/`.tsx`/`.jsx`/`.mts`. The persistent-instance cache key includes the plugin names (the shared fallback closure runs the first instance's plugins).
- **Self**: closes with `Cannot use data.plugins` (a worker must block while the host runs the plugins).

## Tests

`test/plugins.test.ts`: node-worker, node-process, bun-process, deno-process and miniflare with an `oxc-transform` plugin object (async handler) and a host-state plugin (records the ids it saw):

- `.tsx` entry with enum + JSX importing a `.ts` enum module, handler ids are host paths
- `pre` ordering, reload after editing the entry
- virtual `.tsx`/`.ts` keys and an extensionless `format: "tsx"` module
- a handler error on a disk import closes the runner with it (miniflare: link error), a failing invalidated virtual source rejects without changing anything
- CommonJS `.ts`/`.cts` (not Bun)
- `id` filters (glob exclude, case-insensitive RegExp include) keeping `vendor/plain.ts` untouched

Unit tests: validation, candidates, serialized prefilters, ordering/filters/source maps/"still ts", virtual module formats, dropped-map warning, Bun filter, `transformedFormat()`, self runner.
