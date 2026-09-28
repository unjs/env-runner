# Plugins (`plugins` runner option)

Host-side `transform` plugins for the entry, its disk imports and virtual modules. User docs: README "Plugins (`plugins`)". A top-level runner option (also on `LoadRunnerOptions` and `EnvServerOptions`), never part of `data`, since plugins are host objects.

- **`src/plugin/pipeline.ts`** (host) — public types (`EnvRunnerPlugin`, `PluginTransformFilter`, `PluginTopLevelFilterExpression`, ...), `createPluginPipeline()` (flattens `plugins`, validation, `pre`/normal/`post` ordering, filters compiled to their serialized form, async handlers wrapped as `[env-runner] plugin "<name>" failed on "<id>": ...`, `this.warn`/`info`/`debug`/`error` with positions, source maps, output `moduleType` `js`/`ts`, error for leftover JSX) and `transformVirtualModules()`
- **`src/plugin/glob.ts`** (host) — `resolveGlob()` (from cwd unless `**`-prefixed or absolute, once, when the pipeline is created) and `globToRegExp()`: anchored, `*`/`**` match dot files, `\` escapes, `[!..]`, nested/single `{..}`, no extglobs, case-sensitive; `/` compiles to `[\\/]` (and `*` to `[^\\/]*`) so the RegExp also matches Windows paths on Bun
- **`src/plugin/filter.ts`** (shared) — candidates (`isTransformCandidate()`: script extension, no `/node_modules/`), `moduleTypeOf()`, serialized filters (`SerializedPrefilter`: `id` patterns as RegExp `{ source, flags, glob? }`, `g`/`y` dropped; `moduleTypes`; or `expr`, the filter expressions), `compileFilterExpressions()` (three-valued: a `code` leaf without code is unknown; the first include/exclude that matches decides, an unknown before it makes the result unknown) and `createPrefilter()` (sends unless the result is `false`)
- **`src/plugin/channel.ts`** — the sync request channel (host `openTransformPort()`/`openTransformSocket()`, worker `createTransformClient()`)
- **`src/plugin/hooks.ts`** (worker) — `registerPluginHooks()`, `transformedFormat()`, `createBunFilter()`, `servedByPluginHooks()` (Bun reloads)

## Flow

1. `BaseEnvRunner` constructor: `createPluginPipeline(opts.plugins)` (throws `TypeError` for invalid plugins) into `_plugins`. Every runner forwards its `plugins` option to `super()`; `EnvServer` passes its own to each runner it creates.
2. Virtual modules: `_resolveVirtualData()` takes the async path when there are plugins (resolve factories → `transformVirtualModules()`), and `_enqueueVirtualUpdate()` transforms the resolved changes before storing and sending them. `_virtualSources` keeps the originals, so `invalidateModule()` re-transforms. Output format: `commonjs` for CommonJS formats, else `module` (`*-typescript` when the output is still `ts`).
3. `_pluginWorkerData(kind)` adds `data.__envRunnerPlugins = { prefilters, ...channel }` (`PLUGINS_DATA_KEY`) and opens the channel once (`_transformChannel`, closed in `close()`): `"port"` from `NodeWorkerEnvRunner.#initWorker()` (the port goes in `transferList`), `"socket"` from `_processEnv()` (so every process runner gets it through the init-data JSON).
4. Workers call `registerWorkerHooks(data)` (`worker-utils.ts`) so virtual keys win over the plugin hook (their sources are already transformed): `registerPluginHooks()` then `registerVirtualModules()` under `registerHooks` (the latest registration runs first), the reverse on Bun (the earliest `onLoad` whose filter matches wins). Bun's dynamic virtual keys are served with a marker query, which the plugin filter (anchored at the extension) never matches.
5. A load of a candidate the prefilter matches reads the file, sends `{ id, path, code }`, and blocks for `{ id, code?, moduleType? }` (no `code`: unchanged, fall through to `nextLoad()` / Bun's native loader) or `{ id, error }` (thrown from the load).

## Transport

Loader hooks are synchronous (`registerHooks`, and Bun's `onLoad` under `require`), so the worker blocks with `Atomics.wait` on a shared `Int32Array` counter and reads the reply with `receiveMessageOnPort()`. The runner IPC channel can't carry the reply: its listener runs on the blocked thread. Async hooks aren't an option either: Deno and Bun have no `module.register()`, and Node's off-thread hooks deadlock on `require`.

- **node-worker** (and vercel/netlify): a `MessageChannel` + `SharedArrayBuffer` created by the runner. The runner's port answers directly (`port1.unref()`, closed with the runner), then bumps and notifies the counter.
- **Process workers**: the runner listens on a fresh local socket, `transform.sock` in a `mkdtemp` directory (0700, so other users can't connect; `/tmp` when `$TMPDIR` makes the path too long for a unix socket; a `\\.\pipe\env-runner-<pid>-<uuid>` named pipe on Windows). The directory is removed on `close()` and on process exit. A malformed line destroys that connection only. The worker connects after the init-data handshake, by which time the socket is bound. The worker starts an eval helper `Worker` (CommonJS source string, no extra dist file; eval workers work on Node, Deno and Bun) that connects and relays newline-delimited JSON between the socket and a `MessagePort`, notifying the counter per reply. The helper is `unref()`d. When the socket closes, or the helper throws (`uncaughtException`), it answers every request with `{ closed: true, error }`, so a blocked load throws instead of hanging.
- Requests are sequential (one blocked thread), so a reply with a different `id` is stale and skipped. The client reads the counter before each `receiveMessageOnPort()` (a reply posted in between makes the wait return at once) and waits in 10 s slices, warning once per slow module. A handler awaiting its own runner (`fetch()`, `rpc()`) blocks it indefinitely.
- Verified on Node 24, Deno 2.9.6 and Bun 1.4.2 (`Atomics.wait` on the main thread, `SharedArrayBuffer` in `workerData`, eval workers, `node:net` unix sockets from a worker thread).

## Per runtime

- **Node/Deno** (`registerHooks`): `file:` URLs only (query stripped). Output format via `transformedFormat()`: the resolution hint when definite (`module*`/`commonjs*`), then `.m*`/`.c*` extensions, then CommonJS markers + no ESM syntax (es-module-lexer). `ts` output is served as `module-typescript`/`commonjs-typescript` on Node. Deno parses hook output as plain JS, so `ts` output is stripped (`module.stripTypeScriptTypes`, Deno >= 2.8.2) and CommonJS wrapped with `commonJSToESM()` (the virtual modules' wrapper, `virtual-modules.ts`). Untouched CommonJS goes to Deno's native loader (`--unstable-detect-cjs`), and `require()` reads files from disk.
- **Bun** (`Bun.plugin` `onLoad`, can't be removed): one filter RegExp from `createBunFilter(prefilters)`: one alternative per plugin with the extensions its `moduleType` implies (all non-CommonJS ones for filter expressions; never `.cjs`/`.cts`), `id` excludes as negative lookaheads and includes as lookaheads (compiled globs everywhere, user RegExps only off Windows, where they'd see `\`; not folded when flags differ or a source has backreferences/named groups), `/node_modules/` excluded. Paths the RegExp passes but the prefilter doesn't are served with the loader Bun would use. Bun evaluates `onLoad` contents as ESM, so CommonJS (by `transformedFormat()`, transformed or not) is wrapped with `commonJSToESM()`; `ts` output uses the `ts` loader. `_importFresh()` evicts `require.cache` for plugin-served entries (Bun drops the query).
- **Miniflare**: no channel. The module fallback service runs the plugins of the live runner (`ipc.runner._plugins`, swapped when a persistent instance is adopted) on disk modules `transformRequest` returned no code for; `ts` output is stripped on the host, and CommonJS output (`transformedFormat()`) goes behind the ESM shim (its output is kept for the shim's `?__cjs` request, so it is transformed once). Errors are logged on the host and served as a module that throws (a named import fails at link time first, hiding the message from workerd). v4 adds `.cts` to the `modulesRules` it adds for `.ts`/`.tsx`/`.jsx`/`.mts`. The persistent-instance cache key includes whether there are plugins (they change the v4 module rules).
- **Self**: closes with `Cannot use plugins` (a worker must block while the host runs the plugins).

## Tests

`test/plugins.test.ts`: node-worker, node-process, bun-process, deno-process and miniflare with an `oxc-transform` plugin object (async handler) and a host-state plugin (records the ids it saw):

- `.tsx` entry with enum + JSX importing a `.ts` enum module, handler ids are host paths
- `pre` ordering, reload after editing the entry
- virtual `.tsx`/`.ts` keys and an extensionless `format: "tsx"` module
- a handler error on a disk import closes the runner with it (miniflare: link error), a failing invalidated virtual source rejects without changing anything
- CommonJS `.ts`/`.cts` and an untouched CommonJS `.js` under a glob-only `id` filter (all runners, Bun included)
- a code-only plugin on `.ts` (the runtime strips the types)
- a virtual path key overriding a file the plugins would transform
- miniflare `persistent`: the adopting runner's plugins run
- `id` filters (glob exclude, case-insensitive RegExp include) keeping `vendor/plain.ts` untouched
- filter expressions (exclude glob, `and` of `id` glob and `code`) reaching `.hidden/value.ts` in a dot directory

Unit tests: validation, candidates, serialized prefilters, ordering/filters/source maps/`ts` output/leftover JSX/non-string code, virtual module formats, dropped-map warning, Bun filter (glob folding, Windows, expressions), `transformedFormat()`, self runner; `plugin filters`: globs (dot directories, cwd resolution, classes/braces/escapes), query/separators/`g`/`y`, empty and invalid values, expressions on the host and in the prefilter, handler context and `plugins` flattening.
