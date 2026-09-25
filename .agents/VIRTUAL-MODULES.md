# Virtual Modules (Node + Bun + Deno + Miniflare runners)

In-memory ES modules served from a `data.virtual` map (`specifier => source`). Supported by node-worker, node-process, bun-process, deno-process (and vercel/netlify, built on the node-worker worker) via in-worker registration, and by miniflare via a separate host-side path. `self` has no support (`invalidateModule()` throws).

- **`src/common/virtual-modules.ts`** — in-worker registration (`registerVirtualModules()`), invalidation, Bun refresh, unregister
- **`src/virtual-loader.ts`** — sync ESM resolve/load hooks, format-by-extension, factory resolution, transitive-importer expansion, shared TS-strip guard

> See also [`base-runner.ts`](./ARCHITECTURE.md) for the host-side `_resolveVirtualData()` / `_initWithVirtualData()` / `_refreshVirtualSource()` plumbing, and [`worker-utils.ts`](./ARCHITECTURE.md) for `isVirtualSpecifier()` / `_importFresh()` reload handling.

## Core behavior

- **Factories resolve on the host, before spawn** — sources may be `() => string | Promise<string>`, but functions can't cross the `workerData`/JSON boundary and sync load hooks can't await. A throwing factory closes the runner with it as cause; all-string maps keep the spawn synchronous. A factory runs once, and again only on `invalidateModule()`.
- Workers `await registerVirtualModules()` **before** importing the entry. The entry itself may be a virtual key (a virtual key overrides a real file with the same path) and may import other virtual modules.
- **Format comes from the specifier extension**: `.ts`/`.mts` → TypeScript (erasable syntax only), `.json` → JSON module (parsed value as default export), else ESM.
- Registrations live for the thread/process, so virtual specifiers survive `reloadModule()`. Map lookups strip `?query` (so `#entry?__envRunnerReload=1` matches `#entry`) while keeping it in the URL for a fresh identity.
- **Unregister**: `registerVirtualModules()` resolves to an idempotent unregister fn, called by workers on graceful `shutdown` before posting `exit`. Host `close()` kills the worker, which drops it implicitly.
- **Invalidation** (`invalidateModule(specifier)`): re-runs a factory on the host, then sends `invalidate-module` over IPC (ack: `module-invalidated`).
  - It must expand to every virtual module that **transitively imports** the specifier. Otherwise a reloaded entry resolves an intermediate importer to its cached instance, still linked to the old module. The expansion is a quoted-occurrence scan; over-matching is harmless (it only forces a re-evaluation). Disk-file importers are not tracked.
  - Already-linked importers keep their instances, so it must be paired with `reloadModule()`. **`RunnerManager`/`EnvServer` do this automatically**: invalidation marks the manager dirty and the next `fetch()` does one shared reload.
- Unsupported runtime (no `registerHooks`, no `Bun.plugin`) → one-time warning, registration skipped (no crash).

## Node (`module.registerHooks`)

- Detect `registerHooks` via **dynamic `import("node:module")`**, never a static named import. A static import throws at link time on runtimes without it (Node < 22.15/23.5, older Deno).
- In-thread sync hooks. Invalidation bumps per-specifier versions that the resolve hook appends as `?v=<n>` to the `virtual:` URL.
- TS uses the `module-typescript` load format (native stripping, Node >= 22.18/23.6). `with { type: "json" }` is optional, since hook-served modules bypass attribute validation.
- Registrations stack (latest first), so several can coexist and each stays individually invalidatable and unregisterable.

## Bun (`Bun.plugin` + `build.module()`)

- **Never detect Bun via `module.register`**: it exists on Bun but is a silent no-op. Bun lacks `registerHooks`, so it falls through to `Bun.plugin`.
- Mid-program registration only affects subsequent dynamic imports, which is all the workers need.
- The runtime `json` loader doesn't parse contents (it treats them as JS), so JSON is served via the `object` loader as `{ exports: { default } }`. TS uses the `ts` loader.
- **Bun matches `build.module` keys verbatim**, so `?query` cache-busters don't resolve. Reload and invalidation instead re-register the specifier(s) (`refreshVirtualModule()`), which busts Bun's module cache.
- Load callbacks read from a live source map, not captured strings. It is single and latest-wins: a known limitation with multiple registrations.
- No plugin-removal API. Unregistering detaches the source map: cached modules stay, but fresh loads throw.

## Deno (`registerHooks`, with caveats)

- Deno's load hooks **ignore the returned `format`**: every source parses as plain JS, so the map is transformed before registration.
  - `.json` → `export default JSON.parse(...)` wrapper.
  - `.ts`/`.mts` → stripped with `module.stripTypeScriptTypes` (Deno >= 2.8.2). Older Deno **throws at registration**: native stripping isn't reachable from hooks and no stripper is bundled, so callers must pass JS.
- Static imports carrying **any import attribute bypass resolve hooks**, so virtual JSON imports must omit `with { type: "json" }`.
- Verified dead ends: `data:` URLs honor formats, but their static imports skip resolve hooks ("not a dependency"). Registering any custom load hook also breaks `data:` loading ("Loading unprepared module").

## Miniflare (host-side, no in-worker registration)

- TS is pre-stripped on the host (workerd parses every `esModule` as plain JS; a missing stripper gives a clear `TypeError`). `.json` is served as a workerd-native `json` module; fallback-served modules bypass `modulesRules`.
- `unsafeModuleFallbackService` serves virtual keys **before** any other resolution, overriding real files and `transformRequest`. It matches `rawSpecifier`, `specifier` and `specifier` without its leading `/`, with the query stripped. Verified: workerd passes `#`-prefixed specifiers intact.
- Reload keeps `?t=<n>` in the returned module `name` to get a fresh workerd identity.
- A virtual entry skips path handling (anchored at cwd for bare resolution) and is eval-imported verbatim by the wrapper.
- workerd rejects **any** import attribute ("Unrecognized import attributes specified"), so JSON imports must omit `with { type: "json" }`.
- **Named exports** use an explicit `modules` array containing the wrapper, bypassing `ModuleLocator` so static re-exports can resolve through the fallback service at startup. Both virtual entries and a separate `exports` module specifier are supported.
- **Invalidation is host-side only**: it bumps versions for the key plus its transitive virtual importers, and the fallback service rewrites **import specifiers** of invalidated keys in re-served code.
  - Rewritten: static imports/re-exports and literal dynamic imports (including plain template literals).
  - Not rewritten: glob template literals, `import.meta` and arbitrary string literals (code mentioning a key as data is untouched). Unparsable and CJS-shim responses are served as-is.
  - After `reloadModule()`, the versioned specifier misses workerd's by-name registry and hits the fallback again.
- **`persistent: true`**: the resolved virtual map is part of the cache key.
  - The live source/version maps are owned by the cache entry. A runner attaching to a cached instance adopts them, so its invalidation mutates what that instance's fallback actually serves. Ref-counting goes through the entry object, not a key lookup.
  - Invalidating **evicts the entry** from the cache, so later runners built with the original sources get a fresh instance.
- Nothing to unregister: the fallback closure dies with the Miniflare instance.

## Testing

- `test/virtual.test.ts` covers all IPC runners + miniflare (imports, virtual entry, TS/JSON, factories, invalidation incl. via an intermediate importer, reload, shutdown, miniflare-specific rewrite/persistent/exports cases, `SelfEnvRunner` rejection). Attribute-using JSON cases run on Node/Bun only.
- Runner tests spawn workers from `dist/` (via the self-linked `env-runner` package), so run `pnpm build` after worker-side changes.
- Bun/Deno suites auto-skip when the binary is missing. Old-Deno TS fail-fast is detected by probing `deno eval` at collection time.
- `test/fixtures/virtual-unregister.mjs` runs as a node/bun **subprocess** because vitest's module runner intercepts in-process dynamic imports. It covers unregister on both backends.
- `test/fixtures/app-virtual.mjs` is an entry importing `#virtual-message`.
