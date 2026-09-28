# Transforms (`data.transform`)

A generic transformer pipeline for the entry, its disk imports and matching virtual modules. Implemented in **`src/common/transform.ts`** (options, pipeline, runtime hooks) and **`src/common/transform-plugin.ts`** (plugin resolution, hook filters); wired into workers by `registerWorkerHooks()` (`worker-utils.ts`) and host-side by miniflare. TypeScript/JSX compilation is not built into the pipeline: it's the `env-runner/transformers/oxc` transformer (`src/transformers/oxc.ts`), used like any other.

## Options and data flow

- Lives in `data` (not a runner option), so it reaches every runner the same way `data.virtual` does, and must stay **JSON-serializable**. Transformers are `string | URL | [specifier, options]` entries, never functions.
- `BaseEnvRunner` calls `normalizeTransformOptions()` in its constructor. It:
  - resolves specifiers from the host cwd to `file:` URLs, so workers import the app's copies (`env-runner/...` resolves through the package's self-reference);
  - checks options with `_assertSerializable()`: plain objects, arrays and primitives only, since a RegExp/Date/class instance would arrive as `{}`/a string over JSON, and functions not at all;
  - throws a `TypeError` naming the entry index for a non-specifier or bad options.
- `loadTransformer()` (in the worker; on the host for miniflare) returns `undefined` for no transformers (no hooks registered). Otherwise it imports each module and calls `resolveTransformPlugin(default, specifier, options)`:
  - A **function** default export is a **plugin factory**, called once with the options. It may be async (the oxc transformer awaits its `oxc-transform` import). A throw becomes `transformer "<specifier>" failed to initialize: ...`; a non-object result fails.
  - An **object** is the plugin itself; its handler gets the options as `meta.options` (factory plugins get them too).
  - A plugin has `{ name?, transform }`, where `transform` is a function or `{ order?, filter?, handler }`. Bad shapes throw a `TypeError` naming the specifier. A handler returning a thenable throws, since hooks are sync. Handlers get `(code, id, { moduleType, options })` with no plugin context (`this`).
- Hook filters:
  - `id`: glob strings go through `path.matchesGlob` (namespace access, since a named import fails to link before Node 22.5). Relative globs resolve from cwd. RegExps are tested against the `/`-separated id.
  - `code`: strings are substrings.
  - `moduleType`: a list or `{ include }`.
  - Any value can be `{ include, exclude }`, and exclude wins. All given properties must match. `lastIndex` is reset for `g`/`y` RegExps.
- Pipeline: `pre` handlers, then unordered ones, then `post` ones, each group in `transformers` order.
  - `moduleType` starts from the extension (or a virtual module's format), and a result's `moduleType` updates it for later handlers and filters. The oxc transformer returns `js`.
  - **Untouched** code (no handler changed it) returns `undefined`, and callers serve the module as if unmatched: Node/Deno `nextLoad()`, Bun's native loader, miniflare's raw path, the virtual module unchanged.
  - Code that **changed but isn't `js`** at the end throws a `TypeError` naming the id and module type. Serving leftover TypeScript/JSX would need per-backend stripping, and it's almost always a missing oxc entry.
  - An inline `sourceMappingURL` is appended when `sourcemap` (default `true`); `sources` is the file URL for absolute ids.
- The oxc transformer: `transformSync(id, code, { sourcemap: true, lang: moduleType, ...options })`, filtered to `js`/`jsx`/`ts`/`tsx`. `lang` covers virtual keys without a telling extension. Diagnostics with severity `Error` throw a `SyntaxError` with codeframes and the id.
- Maps are never composed. The first map-producing step that changes the code sets the map. A second one would be relative to already-mapped code, so it drops the map, because a wrong map is worse than none. Code-only results keep the current map, and a step returning unchanged code is a no-op.
- `filter(id)` strips the query and normalizes `\` to `/`, then checks all of:
  - the extension is in `extensions` (default `.ts .mts .cts .tsx .jsx`)
  - no `exclude` substring (default `/node_modules/`)
  - `include` matches, if set

  It applies to virtual keys too.

- `include` is a single RegExp. `normalizeTransformOptions()` serializes it to `{ source, flags }`, because JSON (process runners) drops RegExps, and validates it. It also strips `g`/`y`, which would make `test()` alternate through `lastIndex`. `loadTransformer()` accepts either form.
- `oxc-transform` is a devDependency, external in `build.config.mjs`, and only imported by the oxc transformer, by name (`resolveRuntimeDep()` from cwd). Its options are untyped (`unknown` entry options), since env-runner doesn't own their shape.

## Runtimes

- **Node / Deno** (`registerHooks`): a load hook for matching `file:` URLs, filtered on the decoded path. It reads the file itself, so `.tsx`/`.jsx` never hit `ERR_UNKNOWN_FILE_EXTENSION`, and short-circuits.
  - Format comes from `transformedFormat()`. A `module*`/`commonjs*` hint wins. Otherwise `.m*`/`.c*` extensions decide. Otherwise output is CommonJS only with CommonJS markers and no ESM syntax (checked with `es-module-lexer`'s `hasModuleSyntax`, which misses top-level `await`, hence the markers).
  - Node's hint is `null` in packages without `"type"`, `"typescript"` for `require()`, and `undefined` for `.tsx`/`.jsx`.
  - `nextLoad()` can't be used for detection: it throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on enums.
  - Deno ignores the format and evaluates hook output as ESM, so CommonJS output falls back to `nextLoad` (Deno's native loader; CommonJS `.ts` needs `--unstable-detect-cjs`). Deno does call load hooks for disk files.
- **Bun** (`Bun.plugin` `onLoad`): plugin output is always evaluated as ESM, regardless of `loader`.
  - `_bunFilter()` therefore drops `.c*` extensions and encodes `exclude` as a negative lookahead (either path separator), so those paths never reach the plugin and load natively. A transformed CommonJS `.ts` is unsupported.
  - `_bunFilter()` also folds `include` in as a lookahead `(?=.*?(?:source))`, compiled with `include`'s flags. The escaped fixed parts stay valid in `u`/`v` mode; separators use `(?:\\|\/)` rather than a character class. Bun paths keep native separators, so on Windows `include` must match `\` itself.
  - The RegExp is built inside the worker because RegExps aren't serializable.
  - Plugins can't be removed; unregister only detaches the active transformer.
- `_active` is set only after a backend registered, so reload never takes the transform path without a hook behind it.
- **Virtual modules**: `transformVirtualModule()` runs before each backend's own preparation.
  - Workers: `_prepareVirtualModules()` in `virtual-modules.ts`, with the transformer set by `registerWorkerHooks()` through `setVirtualModulesTransformer()`.
  - Miniflare: `#prepareVirtualModule()`.

  So it applies at registration and to every update/invalidation, all eager on every backend (Bun included), and a transform error goes through the existing paths: it fails registration (`init-error`) or rejects the update before anything changes.
  - A module qualifies when its key passes `filter()`, or when it passes `matchesPath()` (`include`/`exclude` only) and its format is TypeScript/JSX (`module-typescript`, `commonjs-typescript`, `jsx`, `tsx`). The initial `moduleType` comes from the format (the oxc transformer passes it as `lang`). An untouched module is returned as is.
  - The output is `{ source, format }` with `format` `commonjs` for `commonjs*`, else `module`. It follows virtual-module rules (no syntax detection; `.ts` is always ESM). The backend preparers then handle it like any JS module: Node natively, Deno/Bun wrapping CommonJS, miniflare as `esModule`/`commonJsModule`.

- **Miniflare**: host-side in `unsafeModuleFallbackService`, after `transformRequest`. Transformed code goes through the same ESM/CommonJS split as raw files, with CommonJS behind `createCjsEsmShim`; `transformedFormat()` decides for transformed code, the existing regex for raw files.
  - Transform errors are `console.error`ed on the host and served as a module that throws the message. The host log matters because a named import of it fails at link time first, and a 500 from the fallback would only surface as "module not found". v4 `modulesRules` include the transform extensions. `data.transform` is part of the persistent cache key.
- **Self**: unsupported (hooks would affect the host process); warns and ignores.

## Reload

`_importFresh()` checks `getActiveTransformer()` for a real-file entry:

- Node/Deno: `file:` URL plus `?__envRunnerReload=n` through the load hook, which strips the query.
- Bun: Bun ignores the query for files in this case, so `delete require.cache[path]` (it also holds ESM) then `import(path)` re-runs the plugin.

Both keep relative imports working, unlike the untransformed `data:` URL path. Already-imported dependencies stay cached.

## Testing

`test/transform.test.ts` runs every IPC runner plus miniflare against `test/fixtures/transform/`:

- `app.tsx` uses an enum and classic JSX with pragma `h`, and imports `dep.ts` (enum) and `h.ts`. It has `// @ts-nocheck` because tsconfig has no `--jsx`.
- Transformers are configured as `["env-runner/transformers/oxc", { jsx: classic, pragma h }]` (resolved through the package self-reference to `dist`, so run `pnpm build` first), followed by `greeting.mjs`, a plugin factory with a `greeting` option.

Further fixtures:

- `cjs/` has a package.json without `"type"`: `lib.ts` (CommonJS with an enum), `dep.cts`, and `vendor/plain.ts` (CommonJS, excluded).
- `app-cjs.ts` and `app-vendor.ts` import them.
- `mapped.mjs` is a transformer returning its own map.
- `greeting-plugin.mjs` is a plugin object: `pre` order, with a glob `id` filter and a `code` filter, reading `meta.options.greeting`.
- `order-*.mjs` and `async.mjs` exercise ordering and the async error.
- `count.mjs` counts its runs; it asserts an invalidated virtual source is transformed once.

Cases:

- disk entry
- reload after editing a temp copy
- virtual `.tsx`/`.ts`, and an extensionless key with `format: "tsx"`
- a transform error closing the runner (virtual source, since invalid syntax on disk breaks `tsc`)
- invalidation with a failing transform (rejects, worker survives)
- CommonJS `.ts` + `.cts` (not Bun; Deno passes `--unstable-detect-cjs`)
- `exclude` to the native loader (not miniflare: workerd can't parse TS)
- `include` with a case-insensitive RegExp that leaves out `vendor/plain.ts`, which would return `"hi"` instead of `"vendor"` if transformed
- a plugin-object transformer listed after oxc (`"hey from tsx"` proves `pre` ran on the source and the entry's options reached the hook)

Option-level tests cover normalization (specifiers, serializable options, `include`), filtering, oxc errors, source maps, plugin ordering, untouched/non-JS output, hook filters, factories and options, and invalid exports.
