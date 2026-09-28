# Transforms (`data.transform`)

Source transforms (TypeScript beyond erasable syntax, JSX, custom) for the entry, its disk imports and matching virtual modules. Implemented in **`src/common/transform.ts`**; wired into workers by `registerWorkerHooks()` (`worker-utils.ts`) and host-side by miniflare.

## Options and data flow

- Lives in `data` (not a runner option), so it reaches every runner the same way `data.virtual` does, and must stay **JSON-serializable**: custom transformers are module specifiers, never functions.
- `BaseEnvRunner` calls `normalizeTransformOptions()` in its constructor: `true` → `{}`, specifiers (`transformers`, `oxcTransform`) resolved from the host cwd to `file:` URLs. Function transformers throw a `TypeError` at construction.
- `loadTransformer()` (in the worker; on the host for miniflare) imports `oxc-transform` via `resolveRuntimeDep({ required: true })` unless `oxc: false`, then imports each transformer (default export, sync `(code, id) => string | { code, map } | nullish`).
- Pipeline: oxc (`sourcemap` forced from `transform.sourcemap`, default `true`) → custom transformers in order → inline `sourceMappingURL`. oxc diagnostics with severity `Error` throw a `SyntaxError` with codeframes and the id. A transformer `map` replaces the previous one; code-only results keep it.
- `filter(id)`: query stripped, `\` normalized to `/`; extension in `extensions` (default `.ts .mts .cts .tsx .jsx`) and no `exclude` substring (default `/node_modules/`). Applies to virtual keys too.
- `oxc-transform` is a devDependency, external in `build.config.mjs`; its types are inlined into `dist` by the dts bundler.

## Runtimes

- **Node / Deno** (`registerHooks`): a load hook for matching `file:` URLs reads the file itself (so `.tsx`/`.jsx` never hit `ERR_UNKNOWN_FILE_EXTENSION`) and short-circuits. Format is `commonjs` when resolution hinted it (`context.format` `commonjs*`) or for `.cts`, else `module`. Deno ignores the format (output is JS anyway) and does call load hooks for disk files.
- **Bun** (`Bun.plugin` `onLoad`): the filter RegExp is built from `extensions` inside the worker (RegExps aren't serializable). Excluded paths matching an extension return the source with Bun's native loader. Plugins can't be removed; unregister only detaches the active transformer.
- **Virtual modules**: `registerVirtualModules(virtual, transformer)` transforms matching keys at registration and on invalidation (via `transformSource`) and forces the `module` format for them. On Bun, the `build.module` callback transforms lazily. Miniflare's `#prepareVirtualSource` transforms instead of type-stripping.
- **Miniflare**: host-side in `unsafeModuleFallbackService`, after `transformRequest` and before the raw disk read. Transform errors are served as a module that throws the message, since a 500 from the fallback would only surface as "module not found". v4 `modulesRules` include the transform extensions. `data.transform` is part of the persistent cache key.
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

Cases: disk entry, reload after editing a temp copy, virtual `.tsx`/`.ts`, and a transform error closing the runner (virtual source, since invalid syntax on disk breaks `tsc`). Option-level tests cover normalization, filtering, errors and `oxc: false`.
