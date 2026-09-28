# Transforms (`data.transform`)

Source transforms (TypeScript beyond erasable syntax, JSX, custom) for the entry, its disk imports and matching virtual modules. Implemented in **`src/common/transform.ts`**; wired into workers by `registerWorkerHooks()` (`worker-utils.ts`) and host-side by miniflare.

## Options and data flow

- Lives in `data` (not a runner option), so it reaches every runner the same way `data.virtual` does, and must stay **JSON-serializable**: custom transformers are module specifiers, never functions.
- `BaseEnvRunner` calls `normalizeTransformOptions()` in its constructor: `true` → `{}`, specifiers (`transformers`, `oxcTransform`) resolved from the host cwd to `file:` URLs. Function transformers throw a `TypeError` at construction.
- `loadTransformer()` (in the worker; on the host for miniflare) imports `oxc-transform` via `resolveRuntimeDep({ required: true })` unless `oxc: false`, then imports each transformer.
- `normalizeTransformer()` (`src/common/transform-plugin.ts`) accepts a default export that is either:
  - a function (the handler), or
  - a rolldown-like `{ name?, transform }` object, where `transform` is a function or `{ order?, filter?, handler }`.

  Plugin factories aren't detected: a function is always the handler. Bad shapes throw a `TypeError` naming the specifier. A handler returning a thenable throws, since hooks are sync. Handlers get `(code, id, { moduleType })` with no rolldown plugin context.

- Hook filters mirror rolldown:
  - `id`: glob strings go through `path.matchesGlob` (namespace access, since a named import fails to link before Node 22.5). Relative globs resolve from cwd, like Vite's `createFilter`, because rolldown's docs don't say. RegExps are tested against the `/`-separated id.
  - `code`: strings are substrings.
  - `moduleType`: a list or `{ include }`.
  - Any value can be `{ include, exclude }`, and exclude wins. All given properties must match. `lastIndex` is reset for `g`/`y` RegExps.
- Pipeline, keeping list order within each group:
  1. `pre` handlers, which see the source (`moduleType` from the extension, as in rolldown, where plugin transforms precede the built-in TS/JSX transform)
  2. oxc (`sourcemap` forced from `transform.sourcemap`, default `true`), after which `moduleType` becomes `js`
  3. functions and default-order plugins
  4. `post` handlers
  5. an inline `sourceMappingURL` (`sources` is the file URL for absolute ids)

  oxc diagnostics with severity `Error` throw a `SyntaxError` with codeframes and the id.

- Maps are never composed. The first map-producing step that changes the code sets the map. A second one would be relative to already-mapped code, so it drops the map, because a wrong map is worse than none. Code-only results keep the current map, and a step returning unchanged code is a no-op.
- `filter(id)` strips the query and normalizes `\` to `/`, then checks all of:
  - the extension is in `extensions` (default `.ts .mts .cts .tsx .jsx`)
  - no `exclude` substring (default `/node_modules/`)
  - `include` matches, if set

  It applies to virtual keys too.

- `include` is a single RegExp. `normalizeTransformOptions()` serializes it to `{ source, flags }`, because JSON (process runners) drops RegExps, and validates it. It also strips `g`/`y`, which would make `test()` alternate through `lastIndex`. `loadTransformer()` accepts either form.
- `oxc-transform` is a devDependency, external in `build.config.mjs`, and never imported statically.
- `OxcTransformOptions`/`OxcJsxOptions` are declared locally and structurally, with nested groups typed as `object`. Inlining oxc's own declarations breaks assignability: its `const enum`s such as `HelperMode` are nominal, so objects typed with the real package would no longer be assignable.

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
  - A module qualifies when its key passes `filter()`, or when it passes `matchesPath()` (`include`/`exclude` only) and its format is TypeScript/JSX (`module-typescript`, `commonjs-typescript`, `jsx`, `tsx`). oxc then gets `lang` from the format.
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
- `greeting.mjs` is a custom transformer.

Further fixtures:

- `cjs/` has a package.json without `"type"`: `lib.ts` (CommonJS with an enum), `dep.cts`, and `vendor/plain.ts` (CommonJS, excluded).
- `app-cjs.ts` and `app-vendor.ts` import them.
- `mapped.mjs` is a transformer returning its own map.
- `greeting-plugin.mjs` is a rolldown-like object: `pre` order, with a glob `id` filter and a `code` filter.
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
- a plugin-object transformer (`"hi from tsx"` proves it ran on the source, before oxc)

Option-level tests cover normalization, filtering, errors, source maps, plugin ordering, rolldown filter semantics, invalid exports and `oxc: false`.
