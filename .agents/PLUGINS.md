# Plugins (`data.plugins`)

Plugin `transform` hooks applied to the entry, its disk imports and virtual modules. Implemented in **`src/common/plugins.ts`** (entry normalization, pipeline, runtime hooks, virtual module transform, Bun filter) and **`src/common/plugin.ts`** (resolving a plugin, hook filters); wired into workers by `registerWorkerHooks()` (`worker-utils.ts`) and host-side by miniflare. env-runner ships no plugins: TypeScript/JSX compilation is a user-land plugin (the README shows a small `oxc-transform` one; tests use `test/fixtures/plugins/oxc.mjs`). There is no settings object: plugins alone decide what they touch, through their hook filters, so scoping is each plugin's job (globs via options, since options are JSON).

## Options and data flow

- Lives in `data` (not a runner option), so it reaches every runner the same way `data.virtual` does, and must stay **JSON-serializable**. Entries are `string | URL | [specifier, options]`, never functions.
- `BaseEnvRunner` calls `normalizePluginEntries()` in its constructor. It:
  - resolves specifiers from the host cwd to `file:` URLs, so workers import the app's copies (`env-runner/...` resolves through the package's self-reference);
  - checks options with `_assertSerializable()`: plain objects, arrays and primitives only, since a RegExp/Date/class instance would arrive as `{}`/a string over JSON, and functions not at all;
  - throws a `TypeError` naming the entry (`data.plugins[0]`, `plugins[0] options.re`) for a non-specifier or bad options. A function/object entry's message points srvx server plugins to the app entry's `plugins` (same name, unrelated option).
- `loadPlugins()` (in the worker; on the host for miniflare) returns `undefined` for no entries (no hooks registered). Otherwise it imports each module and calls `resolvePlugin(default, specifier, options)`:
  - A **function** default export is a **plugin factory**, called once with the options. It may be async. A throw becomes `plugin "<specifier>" failed to initialize: ...`; a non-object result fails.
  - An **object** is the plugin itself; its handler gets the options as `meta.options` (factory plugins get them too).
  - A plugin has `{ name?, transform }`, where `transform` is a function or `{ order?, filter?, handler }`. Bad shapes throw a `TypeError` naming the specifier. A handler returning a thenable throws, since hooks are sync. Handlers get `(code, id, { moduleType, options })` with no plugin context (`this`).
  - Other function-valued hooks (or `{ handler }` objects), e.g. `load`/`resolveId`, are ignored with one `console.warn` per plugin name.
- Hook filters:
  - `id`: glob strings go through `path.matchesGlob` (namespace access, since a named import fails to link before Node 22.5). Relative globs resolve from cwd. RegExps are tested against the `/`-separated id.
  - `code`: strings are substrings.
  - `moduleType`: a list or `{ include }`.
  - Any value can be `{ include, exclude }`, and exclude wins. All given properties must match. `lastIndex` is reset for `g`/`y` RegExps.

## Gating (which modules reach the pipeline)

`PluginPipeline.filter(id, moduleType?)` strips the query, normalizes `\` to `/`, and requires:

- no `/node_modules/` in the path (fixed rule, either separator);
- for files (no `moduleType` given): a script extension (`SCRIPT_EXTENSIONS`: `.js .mjs .cjs .ts .mts .cts .jsx .tsx`); the initial module type comes from it (`_moduleType()`);
- some plugin's **prefilter** matching: its `filter.id` (if any) and `filter.moduleType` (if any) against the initial module type. Plugins without them match every candidate. `filter.code` is not part of the prefilter.

Callers only read a file when `filter()` passes: Node/Deno otherwise `nextLoad()`, miniflare otherwise serves the raw file. Inside the pipeline each handler still checks its full filter (`matches()`) against the current code and module type.

The README recommends a `moduleType` (and, where possible, `id`) filter on every plugin: unfiltered plugins read every script module, and on Bun make CommonJS files break (below). The test oxc plugin filters on `moduleType: ["ts", "tsx", "jsx"]`, so plain JS isn't read with it alone.

## Pipeline

- `pre` handlers, then unordered ones, then `post` ones, each group in `plugins` order.
- `moduleType` starts from the extension (or a virtual module's format), and a result's `moduleType` updates it for later handlers and filters. A compiling plugin returns `js`.
- **Untouched** code (no handler changed it) returns `undefined`, and callers serve the module as if unmatched: Node/Deno `nextLoad()`, Bun's native loader, miniflare's raw path, the virtual module unchanged.
- Code that **changed but isn't `js`** at the end throws a `TypeError` naming the id and module type. Serving leftover TypeScript/JSX would need per-backend stripping, and it's almost always a missing compiling plugin.
- An inline `sourceMappingURL` is appended whenever the pipeline ends with a map; `sources` is the file URL for absolute ids.
- Maps are never composed. The first map-producing step that changes the code sets the map. A second one would be relative to already-mapped code, so it drops the map, because a wrong map is worse than none. Code-only results keep the current map, and a step returning unchanged code is a no-op.
- `oxc-transform` is only a devDependency, for the test fixture plugin; `dist` never imports it.

## Runtimes

- **Node / Deno** (`registerHooks`): a load hook for `file:` URLs passing `filter()` on the decoded path. It reads the file itself, so `.tsx`/`.jsx` never hit `ERR_UNKNOWN_FILE_EXTENSION`, and short-circuits.
  - Format comes from `transformedFormat()`. A `module*`/`commonjs*` hint wins. Otherwise `.m*`/`.c*` extensions decide. Otherwise output is CommonJS only with CommonJS markers and no ESM syntax (checked with `es-module-lexer`'s `hasModuleSyntax`, which misses top-level `await`, hence the markers).
  - Node's hint is `null` in packages without `"type"`, `"typescript"` for `require()`, and `undefined` for `.tsx`/`.jsx`.
  - `nextLoad()` can't be used for detection: it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on enums.
  - Deno ignores the format and evaluates hook output as ESM, so CommonJS output falls back to `nextLoad` (Deno's native loader; CommonJS `.ts` needs `--unstable-detect-cjs`). Deno does call load hooks for disk files.
- **Bun** (`Bun.plugin` `onLoad`): plugin output is always evaluated as ESM, regardless of `loader`, and `onLoad` can't decline a load. So `createBunFilter()` (built in the worker after loading plugins, since RegExps aren't serializable) keeps the one native filter RegExp narrow:
  - `^(?!.*SEP node_modules SEP)` (either separator, `(?:\\|\/)` rather than a character class, so it stays valid in `u`/`v` mode), then **one alternative per plugin** (deduplicated), each ending in `.*(?:<exts>)$`:
    - exts: those its `filter.moduleType` implies (`ts` → `.ts .mts`, `tsx` → `.tsx`, `jsx` → `.jsx`, `js` → `.js .mjs`; unknown types none, so the plugin gets no alternative); without a moduleType filter all of them. Never `.cjs`/`.cts`.
    - its `id` RegExp excludes as `(?!.*?(?:a|b))` (glob excludes dropped: over-approximation is safe), and its includes as `(?=.*?(?:a|b))` when all of them are RegExps (a glob anywhere in the include list drops the include lookahead, since dropping only the glob would under-approximate).
    - The RegExp takes the `id` RegExps' flags (minus `g`/`y`); if flags differ across plugins, no `id` lookaheads at all (extensions only).
  - So with RegExp-only filters it's exact for `id`/`moduleType` (modulo native separators: on Windows `id` RegExps must match `\` themselves). `onLoad` still runs `filter()` and returns untouched or unmatched files with Bun's native loader (`_bunLoader()`). Consequence: CommonJS in any file the RegExp covers breaks (a transformed CommonJS `.ts`, or a CommonJS `.js` when a plugin has no `moduleType` filter). Documented as a limitation, with the advice to filter every plugin.
  - Plugins can't be removed; unregister only detaches the active pipeline.
- `_active` is set only after a backend registered, so reload never takes the plugin path without a hook behind it.
- **Virtual modules**: `transformVirtualModule()` runs before each backend's own preparation.
  - Workers: `_prepareVirtualModules()` in `virtual-modules.ts`, with the pipeline set by `registerWorkerHooks()` through `setVirtualModulesPlugins()`.
  - Miniflare: `#prepareVirtualModule()`.

  So it applies at registration and to every update/invalidation, all eager on every backend (Bun included), and a transform error goes through the existing paths: it fails registration (`init-error`) or rejects the update before anything changes.
  - Candidates are the code formats (`module`, `commonjs`, `module-typescript`, `commonjs-typescript`, `jsx`, `tsx`); the format gives the initial `moduleType` (`js`/`ts`/`jsx`/`tsx`), then `filter(key, moduleType)` applies. An untouched module is returned as is.
  - The output is `{ source, format }` with `format` `commonjs` for `commonjs*`, else `module`. It follows virtual-module rules (no syntax detection; `.ts` is always ESM). The backend preparers then handle it like any JS module: Node natively, Deno/Bun wrapping CommonJS, miniflare as `esModule`/`commonJsModule`.

- **Miniflare**: host-side in `unsafeModuleFallbackService`, after `transformRequest`. Transformed code goes through the same ESM/CommonJS split as raw files, with CommonJS behind `createCjsEsmShim`; `transformedFormat()` decides for transformed code, the existing regex for raw files.
  - Transform errors are `console.error`ed on the host and served as a module that throws the message. The host log matters because a named import of it fails at link time first, and a 500 from the fallback would only surface as "module not found". v4 `modulesRules` add `.cts` when plugins are set. `data.plugins` is part of the persistent cache key (`_plugins`).
- **Self**: unsupported (hooks would affect the host process); warns and ignores.

## Reload

`_importFresh()` checks `servedByPluginHooks()` for a real-file entry on Bun (its `onLoad` filter):

- Node/Deno: `file:` URL plus `?__envRunnerReload=n` through the load hook, which strips the query.
- Bun: Bun ignores the query for plugin-served files, so `delete require.cache[path]` (it also holds ESM) then `import(path)` re-runs the plugin.

Both keep relative imports working, unlike the untransformed `data:` URL path. Already-imported dependencies stay cached.

## Testing

`test/plugins.test.ts` runs every IPC runner plus miniflare against `test/fixtures/plugins/`:

- `app.tsx` uses an enum and classic JSX with pragma `h`, and imports `dep.ts` (enum) and `h.ts`. It has `// @ts-nocheck` because tsconfig has no `--jsx`.
- Plugins are configured as `[oxc.mjs, { jsx: classic, pragma h }]` (a fixture plugin with `oxc-transform`: `moduleType` filter plus an optional `id` filter from its options), followed by `greeting.mjs`, a plugin factory with `greeting` and `id` (filter) options. Workers are spawned from `dist`, so run `pnpm build` first.

Further fixtures:

- `cjs/` has a package.json without `"type"`: `lib.ts` (CommonJS with an enum) and `dep.cts`; `app-cjs.ts` imports them.
- `vendor/plain.ts` is an ES module whose `value` becomes `"hi"` instead of `"vendor"` if a greeting plugin runs on it; `app-vendor.ts` imports it and `cjs/dep.cts`. ESM so the filter tests run (and prove the filter) on every runner, Bun and Deno included.
- `greeting.mjs` with `{ id: { exclude: "**/vendor/**" } }` (glob through options) and `greeting-include.mjs` (case-insensitive `id` RegExp leaving out `vendor/plain.ts`) exercise `id` filters; both tests fail on every runner without the filters.
- `mapped.mjs` is a plugin returning its own map.
- `greeting-plugin.mjs` is a plugin object: `pre` order, with a glob `id` filter and a `code` filter, reading `meta.options.greeting`.
- `order-*.mjs` and `async.mjs` exercise ordering and the async error.
- `count.mjs` counts its runs; it asserts an invalidated virtual source is transformed once.

Runner cases:

- disk entry
- reload after editing a temp copy
- virtual `.tsx`/`.ts`, and an extensionless key with `format: "tsx"`
- a transform error closing the runner (virtual source, since invalid syntax on disk breaks `tsc`)
- invalidation with a failing transform (rejects, worker survives)
- CommonJS `.ts` + `.cts` (not Bun; Deno passes `--unstable-detect-cjs`)
- `id` exclude (glob from options) / include (RegExp) filters, on every runner
- a plugin object listed after oxc (`"hey from tsx"` proves `pre` ran on the source and the entry's options reached the hook)

Unit cases cover entry normalization (including the srvx-plugin mix-up message), candidates (script extensions, `/node_modules/`), prefiltering by `id`/`moduleType` (nothing read or run when no plugin matches), the oxc fixture's `moduleType` filter and `id` option, oxc errors, source maps, plugin ordering, untouched/non-JS output, hook filters, factories and options, the unsupported-hook warning, `createBunFilter()` (extensions, node_modules, per-plugin alternatives with RegExp includes/excludes, globs, missing `id`, mixed flags, custom module types), and invalid exports.
