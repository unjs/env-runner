# Virtual Modules (Node + Bun + Deno + Miniflare runners)

In-memory modules served from a `data.virtual` map (`specifier => source`), in per-module formats (see [Formats](#formats)). Supported by node-worker, node-process, bun-process, deno-process (and vercel/netlify, built on the node-worker worker) via in-worker registration, and by miniflare via a separate host-side path. `self` has no support (a non-empty `data.virtual` closes it with an error; `invalidateModule()` throws).

- **`src/common/virtual-modules.ts`** — in-worker registration (`registerVirtualModules()`), updates (`updateVirtualModules()`), per-backend preparation (Deno transforms, CommonJS wrapper), Bun refresh, unregister
- **`src/virtual-loader.ts`** — source types and formats (`normalizeVirtualModule()`, `virtualModuleFormat()`), JSON transport (`encodeVirtualModules()`/`decodeVirtualModules()`), ESM code for raw formats (`virtualModuleCode()`), sync ESM resolve/load hooks (path-aware, see [Path keys](#path-keys-node--deno)), factory resolution, transitive-importer expansion, shared TS-strip guard

> See also [`base-runner.ts`](./ARCHITECTURE.md) for the host-side `_resolveVirtualData()` / `_initWithVirtualData()` / `_enqueueVirtualUpdate()` plumbing, and [`worker-utils.ts`](./ARCHITECTURE.md) for `isVirtualSpecifier()` / `_importFresh()` reload handling.

## Core behavior

- **Factories resolve on the host, before spawn** — a source may be a factory returning one (`string | Uint8Array | { source, format }`), but functions can't cross the `workerData`/JSON boundary and sync load hooks can't await. A throwing factory closes the runner with it as cause; maps without factories keep the spawn synchronous. A factory runs once, and again only when an update or `invalidateModule()` sets it.
- **Sources are validated on the host** (`normalizeVirtualModule()`, from `_resolveVirtualData()` and each update): an invalid one closes the runner like a throwing factory (even without factories: `_resolveVirtualData()` then returns a rejected promise), or rejects the update before any change. See [Formats](#formats).
- Workers `await registerVirtualModules()` **before** importing the entry. The entry itself may be a virtual key (a virtual key overrides a real file with the same path) and may import other virtual modules.
- **Virtual entry detection** follows the backend:
  - Workers call `isVirtualEntry()`. Under `registerHooks` (Node/Deno) it is **path-aware**: an absolute path or `file:` entry also matches a path key naming the same file (`findVirtualPathKey()`, the hook's URL match). So `/app/x.mjs` and `file:///app/x.mjs` both find key `file:///app/x.mjs`, and load and reload treat the entry as virtual even when a real file exists there. Reloads went through the resolver anyway, but the flag keeps `resolveEntry()`/`_importFresh()` on the virtual path.
  - Elsewhere it is an **exact** `isVirtualSpecifier()` match, so `data.entry` should be spelled like its key. Miniflare (host-side) matches the entry like an import (see [Miniflare](#miniflare-host-side-no-in-worker-registration)). On Bun, a differently spelled path entry still loads virtually for path keys with an extension (`onResolve` path match), but a differently spelled `file:` entry reloads stale, because Bun drops a `file:` specifier's query.
- **Formats** default to the key's extension (`.cjs`, `.ts`, `.json`, `.wasm`, ...), else the source type, and can be set explicitly. See [Formats](#formats).
- Registrations live for the thread/process, so virtual specifiers survive `reloadModule()`. Map lookups strip `?query` (so `#entry?__envRunnerReload=1` matches `#entry`) while keeping it in the URL for a fresh identity.
- **Unregister**: `registerVirtualModules()` resolves to an idempotent unregister fn, called by workers on graceful `shutdown` before posting `exit`. Host `close()` kills the worker, which drops it implicitly. For an empty map it registers nothing, and its unregister covers the registration a later update creates.
- **Invalidation** (`invalidateModule(specifier)`): an update setting the key to its current host-side source (see [Runtime updates](#runtime-updates)), so a factory re-runs. Unknown keys reject on the host.
  - It must expand to every module that **transitively imports** the specifier. Otherwise a reloaded entry resolves an intermediate importer to its cached instance, still linked to the old module.
  - `expandVirtualInvalidation()` walks the reverse **importer edges**, plus a quoted-occurrence scan of the virtual sources for each key. The edges are recorded by the `registerHooks` hooks (Node/Deno) or Bun's `onResolve`; miniflare, which doesn't expose resolution, passes edges lexed from the virtual sources instead (see below). Over-matching is harmless (it only forces a re-evaluation).
  - The edges include **disk files** on Node/Deno (see [Disk importers](#disk-importers-node--deno)). On Bun and miniflare, a cached disk module importing a virtual one keeps the old instance.
  - Already-linked importers keep their instances, so it must be paired with `reloadModule()`. **`RunnerManager`/`EnvServer` do this automatically**: invalidation marks the manager dirty and the next `fetch()` does one shared reload.
- Unsupported runtime (no `registerHooks`, no `Bun.plugin`) → one-time warning, registration skipped (no crash).

## Runtime updates

`updateVirtualModules(changes)`: a source sets (adds or replaces) a key, `null` removes it, all in one round trip.

- **Host** (`BaseEnvRunner._enqueueVirtualUpdate()`): one queue per runner, applied in call order. `changes` is read when its turn comes, so `invalidateModule()` sees earlier updates. Each update:
  1. waits for the initial factory resolution (until then `_data.virtual` aliases the caller's factory map);
  2. runs its factories in parallel (a throw rejects before any change);
  3. updates `_virtualSources` (factories kept) and `_data.virtual` (strings). Both are own copies made in `_resolveVirtualData()`, never the caller's map;
  4. waits for readiness, then applies (`_applyVirtualUpdates()`).

  `reloadModule()` awaits the queue first, so a reload always sees earlier calls.

- **IPC**: `{ event: "update-virtual-modules", id, changes }` (removals as `null`, bytes as base64, see [Transport](#transport-bytes)), acked by `{ event: "virtual-modules-updated", id, error? }`. Workers handle it before `ipc.onMessage`. `handleUpdateVirtualModules()` serializes messages, since creating a registration awaits. Miniflare overrides `_applyVirtualUpdates()` (host-side), and `self` rejects both methods.
- **Worker** (`updateVirtualModules()` in `virtual-modules.ts`):
  - A key changes in the registration serving it, and a new key goes to the latest one. With no registration, one is registered with the added keys, then updated like any other, which versions them (their paths may be cached from disk).
  - All sources are prepared (`_prepareVirtualModules()`: Deno transforms, Bun's CommonJS wrapper, JSX checks) before any registration changes, so a failure changes nothing.
  - The changed keys expand into importers in one walk. Removed keys are still in the map then (quoted scan), and path keys also expand from their `file:` URL: disk importers of the file an added key overrides, and the file a removed key uncovers.
- **Versions** come from one counter per registration, so a key and the disk file it overrides or uncovers never share a `?v=<n>` URL.
- **Entry detection follows updates**: workers call `isVirtualEntry(entry)` after registering and on every reload, which checks the live registrations (`registeredVirtualModules()`).
- `RunnerManager.updateVirtualModules()` marks the manager dirty, like `invalidateModule()`. `EnvServer` also applies the changes to its own copy of `data.virtual`, which the runners it creates later start with. Without an active runner, it only records them.
- **Not tracked**: a runner started without `data.virtual` registers on the first update, so disk modules loaded before that have no importer edges (Node/Deno). A disk module that failed to import a key that didn't exist yet is only re-evaluated when something versions it (Node doesn't cache resolution failures, Deno does).

## Formats

A source is a string, a `Uint8Array`, `{ source, format? }`, or a factory returning one. `virtualModuleFormat(key, module)` is the module's own format, else the key's extension, else `module`.

- **Names**: code formats are Node's load formats (`module`, `commonjs`, `module-typescript`, `commonjs-typescript`, `json`), so the Node backend passes them through; `jsx`/`tsx` are Bun's loader names. Raw formats follow the import attribute proposals (`text`: a string, `bytes`: a `Uint8Array`), and `wasm` default-exports a `WebAssembly.Module`. workerd's names (`esModule`, `commonJsModule`, `data`) weren't used: they are workerd-specific, and a `data` module is an `ArrayBuffer`.
- **Defaults**: `.cjs` → `commonjs`, `.cts` → `commonjs-typescript`, `.ts`/`.mts` → `module-typescript`, `.json`, `.jsx`, `.tsx`, `.wasm`; other keys are `module` for a string, `bytes` for a `Uint8Array`. There is no `package.json` `type` lookup (`.js`/`.ts` are always ESM). Before formats, `.cjs`/`.cts`/`.jsx`/`.tsx`/`.wasm` keys were served as plain ESM.
- **Normalization** (`normalizeVirtualModule()`, on the host): a string stays a string (its format follows the key, computed the same way in the worker). Anything else becomes `{ source, format }` with the format resolved and bytes copied into a plain `Uint8Array` (also from a `Buffer`). It throws a `TypeError` naming the key for a value that isn't a source, an unknown format, a string for `bytes`/`wasm` or bytes for any other format, and bytes that `WebAssembly.validate()` rejects (so a bad binary fails everywhere at registration, instead of at import or by crashing workerd).
- **Runtime support** (JSX) is checked by each backend when preparing: in the worker, since node-worker on a Bun host uses the Bun backend, and on the host for miniflare.

| Format                | Node (`registerHooks`) | Deno (`registerHooks`) | Bun (`Bun.plugin`)       | Miniflare (fallback)              |
| --------------------- | ---------------------- | ---------------------- | ------------------------ | --------------------------------- |
| `module`              | native                 | native                 | `js` loader              | `esModule`                        |
| `commonjs`            | native                 | ESM wrapper            | ESM wrapper              | `commonJsModule` + `namedExports` |
| `module-typescript`   | native (22.18+)        | stripped               | `ts` loader              | stripped on the host              |
| `commonjs-typescript` | native (22.18+)        | stripped, ESM wrapper  | ESM wrapper, `ts` loader | stripped, `commonJsModule`        |
| `json`                | native                 | `JSON.parse()` module  | `object` loader          | `json`                            |
| `jsx`, `tsx`          | error                  | error                  | `jsx`/`tsx` loaders      | error                             |
| `text`                | generated ESM          | generated ESM          | `object` loader          | `text`                            |
| `bytes`               | generated ESM          | generated ESM          | `object` loader (a copy) | generated ESM                     |
| `wasm`                | generated ESM          | generated ESM          | `object` loader          | `wasm`                            |

Generated ESM (`virtualModuleCode()`): text as a JSON string literal; bytes as base64, decoded with `Uint8Array.fromBase64()` (missing on Node 24) or `atob()`; wasm as `new WebAssembly.Module(bytes)` over them.

### CommonJS

- **Node** (verified on 24.21): the sync hooks return `format: "commonjs"` with the source. `require()` inside goes through the hooks (`require` condition), so virtual keys, relative path keys and packages all resolve. Named exports come from Node's own lexer (re-exports included), plus its `"module.exports"` export. `__filename` is the path of a path key, else the `virtual:` URL.
- **ESM wrapper** (`_commonJSToESM()`, Bun and Deno): the source runs in `(function (exports, require, module, __filename, __dirname) {...})`, opened on the wrapper's first line so line numbers are kept. It's strict-mode code (inside an ES module). `require` is `createRequire()` at the key's path, else cwd (a trailing-slash base; Bun maps it to `<cwd>/noop.js`). Exports: `default` and `"module.exports"` are `module.exports` (Node and Bun return that export from `require(esm)`, verified), named ones come from cjs-module-lexer (imported lazily, the first time a CommonJS module is prepared; re-exports aren't followed).
  - Bun parses plugin sources as ES modules only (verified on 1.4.2: `js` loader contents give an empty namespace, also for `.cjs` paths and a `// @bun @bun-cjs` pragma). Evaluating the source in `onLoad` (`object` loader) works for `import`, but `require()` of it returns the namespace, and it runs when loaded, out of evaluation order. The wrapper's `require()` reaches the plugin, so virtual modules resolve and importer edges are recorded (for path keys, whose base is the key's path).
  - Deno: `createRequire()`'s `require` goes through resolve hooks but reads the file from disk (`No such file or directory` for a virtual key, the real file for an override), so it can't reach virtual modules. `require()` of an ES module panics Deno 2.9.6 whenever a load hook is registered (`libs/core/modules/map.rs`), also for real files; CommonJS packages and builtins work.
- **workerd** (verified on v5): `commonJsModule` runs in sloppy mode, its default export is `module.exports`, and `namedExports` become named exports. `require()` goes through the fallback (`X-Resolve-Method: require`). Disk CommonJS keeps its older ESM shim + `?__cjs` module.
- **Invalidation**: Node evicts `require.cache` (see [Node](#node-moduleregisterhooks)), the Bun and Deno wrappers are ES modules versioned by URL, and miniflare only rewrites `import` specifiers, so a `require()`d virtual module keeps its first instance there.
- **Node quirk (also with real files)**: once a module that CommonJS re-exports (`module.exports = require("./dep.cjs")`, or `{ ...require() }`) is evicted, importing the re-exporter from ESM reads it as an empty circular module (`Accessing non-existent property ... inside circular dependency`). Node's ESM preparse (`cjsPreparseModuleExports()`) emplaces an unloaded `require.cache` entry for re-export targets, and `Module._load`'s relative-resolve fast path returns it without checking that the ESM loader created it. Reproduced with real files and `delete require.cache[...]`, without hooks. Assigning first (`const dep = require(...)`) works.

### Wasm

The default export is a compiled `WebAssembly.Module` everywhere, native only on workerd. Native `.wasm` imports disagree: Node 24 (unflagged, with an experimental warning) and Deno 2.9 instantiate the module (Wasm ESM integration: instance exports as named exports), Bun's default export is the file path, and workerd forbids compiling at runtime (`Wasm code generation disallowed by embedder`, verified on v5). A `WebAssembly.Module` default export is the one semantics workerd allows, and elsewhere it can be emulated. It is also the value of a source-phase import and of wrangler's `CompiledWasm` rule.

### Transport (bytes)

- `workerData` (node-worker) passes `Uint8Array`s natively (structured clone).
- JSON channels, the process workers' init data (`_processEnv()`) and every update message (`_applyVirtualUpdates()`, node-worker included), carry `encodeVirtualModules()` output: `{ source: "<base64>", format, encoding: "base64" }`. Workers call `decodeVirtualModules()` on registration and on updates. It only touches objects with `encoding`, so native bytes pass through. Strings stay strings on the wire, so a string-only `data.virtual` looks as before to custom workers.
- `expandVirtualInvalidation()`'s quoted scan only reads code (`virtualModuleCodeSource()`): JSON, text and bytes import nothing, and a text module mentioning a key isn't its importer.

## Node (`module.registerHooks`)

- Detect `registerHooks` via **dynamic `import("node:module")`**, never a static named import. A static import throws at link time on runtimes without it (Node < 22.15/23.5, older Deno).
- In-thread sync hooks. Invalidation bumps per-key versions that the resolve hook appends as `?v=<n>` to the served URL (`virtual:` or path key `file:` URL, after the import's own query).
- Code formats are returned as Node load formats (`module-typescript`/`commonjs-typescript`: native stripping, Node >= 22.18/23.6); `text`/`bytes`/`wasm` as generated ES modules (`_nodeLoadResult()`). `with { type: "json" }` is optional, since hook-served modules bypass attribute validation.
- **CommonJS is cached by filename** (`require.cache`), whatever the version query: by path for path keys, by the query-less `virtual:` URL when `require()`d (`virtualModuleCacheId()`). So every versioned key is evicted from `require.cache` (`_updateHooksRegistration()`), which also lets a removed path key uncover the real file. See [Formats](#formats) for the one pattern that still breaks.
- Registrations stack (latest first), so several can coexist and each stays individually invalidatable and unregisterable.

## Path keys (Node + Deno)

`createVirtualHooks()` splits keys into two kinds:

- **Path keys**: absolute paths (`path.isAbsolute`, so `C:\...` on Windows) and `file:` URLs. Each is identified by its `file:` URL (`pathToFileURL(key)`, or the URL without query/hash).
- **Other keys** (`#name`, bare, relative, `virtual:`-style) keep the original behavior. They match the specifier verbatim (query stripped) and are served under a readable `virtual:<specifier>` URL (see [Ids of non-path keys](#ids-of-non-path-keys)). Imports from them are re-based on cwd (`baseURL`), since the opaque scheme breaks default resolution.

The resolve hook tries, in order:

1. An **exact key** of either kind. A path key keeps the import's query on its `file:` URL.
2. **Relative, root-relative and `file:` specifiers**, resolved by hand with `new URL(specifier, parent)`, and other absolute paths via `pathToFileURL`. The result is matched against the key URLs. This step exists because default resolution throws for files that aren't on disk. A non-hierarchical parent (`data:`) falls through.
3. `nextResolve()`, whose result URL is also matched against the key URLs. That covers bare and `#imports` specifiers that resolve onto an existing, overridden file.

Other behavior:

- Path keys are **served under their real `file:` URL**, plus query and `v=<n>`. As a result, `import.meta.url`/`dirname`/`filename` are real. Their own imports go through default resolution from the key's directory, and that directory need not exist: both Node's `node_modules` walk and Deno handle a missing directory.
- The load hook serves any `virtual:` URL, or any `file:` URL whose query-less form is a key URL, however it was resolved. This is what makes overrides of real files work.
- **Importer edges**: whenever a key is served and the parent URL maps to a key of the same registration, the hook records `key → importer`. Linking resolves every static import once per module instance, and dynamic imports resolve on execution, so every linked importer has an edge. Disk importers are covered in [Disk importers](#disk-importers-node--deno). Cross-registration edges are not tracked.
- If two keys resolve to the same URL (`/a.mjs` and `file:///a.mjs`), the later one wins URL matching (the host warns, see [Key collisions and shadowing](#key-collisions-and-shadowing)).
- **Updates**: `createVirtualHooks()` also returns `updateKeys(keys)`, which re-indexes the URL maps for keys added to or removed from the live map (an added key wins its URL; a removed one hands it to another key naming the same file). Sources are read live, so a replaced one needs no call. A removed path key's `file:` URL gets a fresh version, so default resolution loads the real file fresh: the key's module may be cached under the plain URL.

## Disk importers (Node + Deno)

A cached disk module that imports a virtual module (the entry's `./lib.mjs` importing `#config`) would keep linking the old instance. So the `registerHooks` hooks also track disk files, identified by bare `file:` URL (no query/hash), in the same `importers`/`versions` maps as keys:

- **Load hook**: records every `file:` module it passes to `nextLoad()` whose format is ESM (`module`, `module-typescript`), or unknown. Deno's `nextLoad()` reports no format.
- **Resolve hook**: for every resolution to a `file:` URL, and for every served key, it records `module → importer`. The importer is recorded only if it is a key, or a file recorded by the load hook and not a `require()` resolution.
- Invalidation walks the edges up from the key through disk files. It bumps their versions too, and the resolve hook appends `?v=<n>` to `nextResolve()` results for versioned files.
- The quoted scan only runs for keys, since disk files are reachable only through edges.

Scope and verified behavior:

- **The walk stops at the entry.** The worker module that imports the entry was loaded before registration, so it is never recorded. Only modules on a path from the entry to the invalidated key are busted, not the ones they share with unrelated modules (`shared.mjs` in the tests stays one instance).
- The default loaders re-read a `file:` URL with an added query as a fresh instance, while its own imports stay cached (verified on Node 24 and Deno 2.9). `import.meta.url` gains `?v=<n>`. `import.meta.filename`/`dirname` are unaffected.
- **CommonJS is never re-evaluated**: both runtimes cache it by filename and ignore the query.
  - On Node, CommonJS files aren't recorded as importers (format `commonjs`), so the walk stops there.
  - On Deno (no format), CommonJS files reached through `import()` are recorded and versioned. That's harmless, since they stay cached, and their ESM importers are only over-busted.
  - `require()` of a busted ES module still returns its original instance (Node: `require(esm)` ignores the query). So a module with both ESM and `require()` importers ends up with two live instances after an invalidation.
- Dynamic importers count as importers (the hook can't tell them apart), which only over-busts.
- Re-evaluating a busted module re-runs its side effects, as with the entry itself.

## Bun (`Bun.plugin`: `onResolve`/`onLoad` + `build.module()`)

- **Never detect Bun via `module.register`**: it exists on Bun but is a silent no-op. Bun lacks `registerHooks`, so it falls through to `Bun.plugin`. On a Bun host, node-worker/node-process workers run in Bun and use this backend too.
- Mid-program registration only affects subsequent dynamic imports, which is all the workers need.
- The runtime `json` loader doesn't parse contents (it treats them as JS), so JSON is served via the `object` loader as `{ exports: { default } }`, and so are `text`, `bytes` (a copy per load) and `wasm` (runtime plugins reject Bun's `text`/`file`/`wasm` loaders). TS uses the `ts` loader, JSX the `jsx`/`tsx` loaders. CommonJS is wrapped (see [Formats](#formats)).
- **Runtime `onResolve` only sees some specifiers** (Bun's `couldBePlugin`): the last `.` must precede a letter or non-ASCII char, or the specifier is `ns:...` (routed to namespace `ns`). `#name`, bare and extensionless specifiers never reach it, with or without a `?query`. `file:` specifiers arrive as paths, with their query dropped. Each registration is one `Bun.plugin()`, and keys are split by what Bun can see (`_createBunRegistration()`):
  - **Path keys** (absolute paths, `file:` URLs as paths) whose basename passes the check: `onResolve` resolves absolute, `file:` and relative specifiers (against the importer's path, or cwd for non-path importers). They're served under the real path (`file` namespace) by `onLoad`. So relative virtual→virtual imports, overrides of real files, and a real `import.meta.url`/`dirname`/`filename` all work.
  - **Other keys passing the check** (`#util.ts`, `#config.json`, no `:`): matched verbatim with the query stripped, and served in the `env-runner-virtual` namespace. Their imports resolve from cwd, like `build.module()` ones.
  - **The rest** (extensionless keys, keys with `:`): `build.module()`. It matches verbatim and wins over `onResolve`. So `#m?raw` never matches (`Cannot find package`), and neither does a relative or `file:` import of an extensionless path key.
  - Native `filter` regexes (namespaced keys verbatim, path keys by basename) keep unrelated imports off the JS callbacks.
- **Bun calls `onResolve` again on the path it returned** (empty importer), and again when linking the rewritten imports. So resolution is idempotent: an id already ending in the current `v=<n>` is returned unchanged.
- **Cache busting never calls `Bun.plugin()` again.** Re-registered `onResolve` callbacks pile up: after 5000 re-registrations, an import ran 15003 callbacks and took ~4 ms instead of ~60 µs. `build.module()`-only re-registration doesn't measurably pile up, but it can't serve relative or queried imports.
  - `onResolve` keys: invalidation/`refreshVirtualModule()` bumps a per-key version, served as `?v=<n>` (fresh id, like Node). The superseded ids are then evicted with `delete require.cache[id]`, which also drops ES modules from Bun's registry.
  - That eviction is undocumented, so it's best effort: correctness relies on the version. Without it, every busted module kept 1 module record (~1 KB heap per tiny module) per cycle. With it, the count stays flat, as before.
  - `build.module()` keys: re-registered through the builder saved at setup (still usable after `setup()` returns), which evicts the specifier.
- **Importer edges** are recorded in `onResolve`. The importer id is a served path, `env-runner-virtual:<key>`, or a `build.module()` specifier. Imports _of_ `build.module()` keys bypass `onResolve`, but they're spelled verbatim, so the quoted scan finds their importers.
- **Registrations stack**: plugin callbacks dispatch through a live list (latest first). So the latest wins for a shared key, and each registration stays invalidatable and can be unregistered separately.
- **`onLoad` can't decline a module**: once a filter matches, returning `undefined` throws `onLoad() expects an object returned` (verified on Bun 1.4.2). So a path that must load from disk again is resolved to `<path>?__env_runner_disk[&query]&v=<n>`, a leading marker that every `onLoad` path filter excludes (negative lookahead): Bun then loads the real file itself, in any format, or fails with `ENOENT`.
- No plugin-removal API. Unregistering detaches the registration: cached modules stay. Fresh loads of namespaced/`build.module()` keys throw, and its path keys resolve with the disk marker, so an overridden real file loads from disk again.
- **Updates** (see [Runtime updates](#runtime-updates)):
  - Setup filters only match the keys a registration started with. A namespaced or path key added later is routed through two shared callbacks, installed once per realm through a saved builder (`onResolve`/`onLoad` still work after `setup()` returns): a catch-all `onResolve`, and an `onLoad` for ids with the leading `?__env_runner_virtual` marker, which added path keys are served with. The catch-all pre-checks the specifier's last segment against the names of added keys, so other imports skip the resolution. Added `build.module()` keys register through the saved builder.
  - Measured on Bun 1.4.2 over 4000 disk module loads: one narrow filter pair per update batch would cost ~0.4 µs per load per batch (100 batches: 49 → 80 µs per load; 1000: 470 µs), like a new `Bun.plugin()` per batch. The shared callbacks cost 49 → 52 µs for any number of batches (56 µs without the pre-check).
  - A removed path key becomes a tombstone (`removed`): it keeps resolving, to the real file with the disk marker and a fresh version, since its module may be cached under the plain path. A namespaced key falls through to Bun's resolution. A removed `build.module()` key can't be unregistered, so its fresh loads throw instead of falling through.
- **Bun bug (not env-runner)**: JSC's in-memory code cache occasionally runs another source's code for a fresh module id. Verified on Bun 1.4.2: `export default 1743;` evaluated as `1433` (2 in 5000 fresh modules), also for plain disk files busted with `?v=`. It's gone with `BUN_JSC_useCodeCache=0`.

## Deno (`registerHooks`, with caveats)

- Deno's load hooks **ignore the returned `format`**: every source parses as plain JS, so the map is transformed before registration (`_prepareForDeno()`). Deno 2.9 honors `json`, `text` and `wasm` (as Wasm ESM integration), but not `commonjs` (`module is not defined`) or `tsx` (parsed as JS), so everything is transformed and served as `module`.
  - JSON → `export default JSON.parse(...)` wrapper.
  - TypeScript → stripped with `module.stripTypeScriptTypes` (Deno >= 2.8.2). Older Deno **throws at registration**: native stripping isn't reachable from hooks and no stripper is bundled, so callers must pass JS.
  - CommonJS → the ES module wrapper (after stripping for `commonjs-typescript`); `text`/`bytes`/`wasm` → `virtualModuleCode()`; JSX → throws.
- **`.cjs`/`.cts` `file:` URLs never reach the load hook** (Deno's CommonJS loader reads them from disk: `Module not found` for a missing file, also with a query; verified on 2.9.6, no other extension does this). Path keys with those extensions are served under their `virtual:` URL instead (`opaquePathURL`), and imports from them resolve from the key's directory. Their `import.meta` isn't the file's, which CommonJS doesn't use.
- Static imports carrying **any import attribute bypass resolve hooks**, so virtual JSON imports must omit `with { type: "json" }`.
- Verified dead ends: `data:` URLs honor formats, but their static imports skip resolve hooks ("not a dependency"). Registering any custom load hook also breaks `data:` loading ("Loading unprepared module").
- **Path keys work as on Node** (verified on Deno 2.9.6). That includes:
  - hook-served `file:` URLs for files that exist and files that don't, including `.json`/`.ts` extensions (forced `module` format over pre-transformed sources);
  - versioned and reload queries;
  - `import.meta.dirname`/`filename`;
  - overrides of statically imported real files;
  - bare packages from a missing directory.

  No "Loading unprepared module" error came up for `file:` URLs. Bare resolution does need a `package.json` in scope: without one, Deno's `nextResolve` maps `pkg` to `<dir>/pkg`.

## Miniflare (host-side, no in-worker registration)

- TS is pre-stripped on the host (workerd parses every `esModule`/`commonJsModule` as plain JS; a missing stripper gives a clear `TypeError`), and JSX throws there (`#prepareVirtualModule()`). The rest uses workerd module types (`_serveVirtual()`): `json`, `text`, `wasm`, and `commonJsModule` with `namedExports` from cjs-module-lexer. `bytes` is a generated ES module, since a `data` module is an `ArrayBuffer`. Fallback-served modules bypass `modulesRules`.
- `unsafeModuleFallbackService` serves virtual keys **before** any other resolution, overriding real files and `transformRequest`. It matches `rawSpecifier`, `specifier` and `specifier` without its leading `/` verbatim, with the query stripped, then path keys by path (see below). Verified: workerd passes `#`-prefixed specifiers intact.
- `createVirtualKeyResolver()` (in `runner.ts`) is the one lookup behind the fallback, the entry, importer edges and specifier rewriting: verbatim key (query stripped), else a path key by absolute path, with `./`/`../` specifiers joined onto the importer's path.
- Reload keeps `?t=<n>` in the returned module `name` to get a fresh workerd identity.
- The entry is matched like an import. A non-path virtual key skips path handling (anchored at cwd for bare resolution) and is eval-imported verbatim by the wrapper. A path key (even spelled as a `file:` URL, or differently from `data.entry`) is imported by its path.
- workerd rejects **any** import attribute ("Unrecognized import attributes specified"), so JSON imports must omit `with { type: "json" }`.
- **miniflare v4's `ModuleLocator` statically walks the wrapper `script`**, so literal virtual specifiers must never appear in it (`dynamicOnly` mode). Named exports need static re-exports, so with a virtual entry (or an `exports` module specifier) the wrapper is passed as a `modules` list instead, which skips the locator; the fallback serves the re-exports at startup. v5 has no locator.
  - A **real** entry with detected exports still goes through the v4 locator, which reads its static import graph from disk: a virtual import fails (`ERR_MODULE_RULE`) and an override is ignored. See [`MINIFLARE.md`](MINIFLARE.md) for why it isn't switched too.
- **Invalidation is host-side only**: it bumps versions for the key plus its transitive virtual importers, and the fallback service rewrites **import specifiers** of invalidated keys in re-served code.
  - Importers: `virtualImporters()` lexes the imports of each virtual ES module (not CommonJS, whose `require()` isn't rewritten) and resolves them with the resolver (relative ones against the key's path), and passes them as edges to `expandVirtualInvalidation()`.
  - Rewritten: static imports/re-exports and literal dynamic imports (including plain template literals). They are resolved against the served module's path (the key's path, or `resolvedPath` for disk files), and `?v=<n>` (`&v=<n>` after a query) is appended in place.
  - Not rewritten: computed dynamic specifiers (template literals with `${}` substitutions, variables, concatenation), `import.meta` and arbitrary string literals (code mentioning a key as data is untouched). Unparsable and CJS-shim responses are served as-is. A computed import keeps resolving the first-loaded instance until the runner restarts.
  - After `reloadModule()`, the versioned specifier misses workerd's by-name registry and hits the fallback again.
  - Disk importers other than the re-imported entry aren't re-served, so a virtual module reached through them stays stale.
- **Updates are host-side too** (`_applyVirtualUpdates()`): the fallback reads one live state object (`MiniflareVirtualModules`: sources, versions, resolvers), created even for an empty map. An update strips TS first (a failure changes nothing), expands importers over the old and new sources merged (a removed key keeps its importers, an added key finds those already importing it), then changes the sources and rebuilds the resolvers.
  - A removed key stays in `removed`, so re-served importers keep versioning their import of it. The versioned specifier misses workerd's cache, where the key's module may sit under the plain name, and the fallback resolves it normally: the real file, a `404`, or the empty stub for an unresolvable bare specifier.
  - Versions come from one counter, so no two instances share a name.
- **`persistent: true`**: the resolved virtual map is part of the cache key, bytes as base64 (`encodeVirtualModules()`), not `JSON.stringify()`'s index objects.
  - The live state is owned by the cache entry. A runner attaching to a cached instance adopts it, so its updates change what that instance's fallback actually serves. Ref-counting goes through the entry object, not a key lookup.
  - An update (or invalidation) **evicts the entry** from the cache, since the sources no longer match its key: later runners get a fresh instance, whether built with the original or the updated sources. Re-keying it instead would let a restarted runner attach to an instance whose entry hasn't been reloaded since the update.
- Nothing to unregister: the fallback closure dies with the Miniflare instance.
- **Path keys** match workerd's resolved specifier (`/abs/path.mjs`) by path; a `file:` key is equivalent to its `fileURLToPath()`. So relative virtual→virtual imports, real-file overrides, and relative or bare imports from a path key all work, and invalidation reaches importers through relative specifiers.
  - workerd joins relative specifiers onto the importer's name as plain text (no percent-decoding), so the resolver does too (`path.resolve`, not `new URL`).
  - A `file:` import arrives with `specifier` wrongly joined onto the referrer's directory (`/dir/file:/x.mjs`), so the raw URL is matched instead. The fallback answers `301` to the key's path, so both spellings share one module and its relative imports resolve (verified on v4 and v5).
  - If two keys map to the same path (`/a.mjs` and `file:///a.mjs`), an exact spelling wins, else the later key (the host warns).
  - `import.meta.url`/`dirname`/`filename` are undefined.

## Key collisions and shadowing

- **Path keys naming the same file** (`/app/x.mjs` and `file:///app/x.mjs`, or a path with `..` segments): only one can be served. That's the later key on Node, Deno and Bun, an exact spelling first on miniflare, and each spelling verbatim for Bun's extensionless (`build.module()`) keys.
  - `warnVirtualPathCollisions()` (`virtual-loader.ts`) warns once per pair and process, naming both keys. It compares keys by `_virtualKeyURL()`, like the resolver, and never throws.
  - It runs on the host in `_resolveVirtualData()`, which every runner except `self` goes through before spawning. So all runners warn the same way, and neither each worker nor each hot-reloaded runner repeats it. An update that adds keys runs it again over the updated map (already warned pairs stay quiet).
- **Shadowing**: non-path keys match their specifier from every importer, dependencies included. A bare key (`react`) replaces an installed package, and a `#name` key a dependency's own `#name` subpath import (verified on Node, Bun and Deno; miniflare's fallback serves keys before any resolution).
  - Deliberately **no warning**. Overriding a package is the only way to alias or stub it, so a warning would fire on every start for intended overrides and need a new opt-out option.
  - A cheap check wouldn't be reliable either: "installed" depends on the backend (`node_modules`, PnP, Deno's npm cache, workerd built-ins), and dependencies' subpath imports would need a scan of every package.
  - The README documents it and recommends distinctive names (`#app/config`).

## Ids of non-path keys

Path keys run under their real `file:` URL (miniflare: no `import.meta.url`). Non-path keys have no file, so each backend gives them its own id, which shows up in `import.meta.url` and stack traces:

| Backend                                              | `import.meta.url`                         | Stack frame                           |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| Node, Deno (`registerHooks`)                         | `virtual:#config`, `virtual:@scope/pkg`   | `at virtual:#config:2:7`              |
| Bun, `build.module()` keys (`#config`, `@scope/pkg`) | `file:///%23config`, `file:///@scope/pkg` | `at #config:2:7`                      |
| Bun, namespaced keys (`#util.mjs`)                   | `file:///env-runner-virtual:%23util.mjs`  | `at env-runner-virtual:#util.mjs:2:7` |
| Miniflare                                            | `undefined`                               | `at #config:2:7`                      |

Reloads and invalidation add their query (`virtual:#config?v=1`), except for Bun's `build.module()` keys.

The `registerHooks` URL is `virtual:` + the specifier (with its query), percent-encoding only what a URL parser would change or misread: `%`, controls, space, `"`, `<`, `>`, backtick and non-ASCII (`_virtualURL()`). It used to be fully encoded (`virtual:%23config`). So:

- `new URL(url).href === url`, and decoding the part before the first `?` gives the key back (keys can't contain `?`: lookups strip the query). A malformed escape (another hook's `virtual:` URL) just doesn't match.
- A `#name` key lands in the URL **fragment** (`virtual:#config` has an empty path). That's safe for identity: Node and Deno key module instances by the full URL, fragment included, like the HTML module map (verified on Node 24 and Deno 2.9.6: `virtual:#a`, `virtual:#b` and `virtual:#a?v=1` are separate instances). The query then sits inside the fragment too, so versions are appended at the end (`_appendQuery()` skips the fragment split for `virtual:` URLs). Tools that drop fragments would conflate `#` keys, and `new URL(import.meta.url).pathname` is empty.
- Deno percent-decodes stack frames itself, but not error messages (`Unexpected token ';' at virtual:#config:1:18`).

## Error messages

Where a failing virtual module is named (verified on Node 24, Deno 2.9.6, Bun 1.4.2 and miniflare v5):

| Failure           | Node                           | Deno                          | Bun                         | Miniflare            |
| ----------------- | ------------------------------ | ----------------------------- | --------------------------- | -------------------- |
| Top-level throw   | stack frame                    | stack frame                   | stack frame                 | stack frame          |
| JS syntax error   | nowhere                        | message (`at virtual:#x:1:5`) | `position` (`BuildMessage`) | nowhere              |
| Missing export    | failing line above the stack   | message                       | imported module only        | imported module only |
| Invalid JSON      | message (`virtual:#x.json: …`) | stack frame (`JSON.parse`)    | message (`_parseBunJSON()`) | nowhere              |
| TypeScript syntax | failing line above the stack   | message (registration)        | `position`                  | message (host)       |

- **`formatInitError()`** (`worker-utils.ts`) builds the worker `init-error` message, which becomes the runner's close cause and the `[env-runner] worker init failed: ...` line. It appends ` (at <location>)` when the message has none: Bun's `position`, else Node's failing line above the stack header (link and TypeScript errors), else the first stack frame with a location. So a top-level throw reads `dep failed (at virtual:#dep:2:7)`.
  - Skipped for env-runner's own `[env-runner] ...` errors (they say what failed, and their top frame is env-runner code) and for runtime-internal frames (`node:`, `ext:`, `native:`).
  - The miniflare wrapper appends the first stack frame to its `Failed to load entry: ...` response the same way (`__errorLocation()`).
- **TypeScript stripped for Deno and miniflare** (`stripVirtualTypeScript()`) and **Bun's JSON parsing** (`_parseBunJSON()`) throw `[env-runner] ...` errors naming the key, with the original error as `cause`. The stripper and `JSON.parse()` never see the module name.
- **Gaps**:
  - A JS syntax error in an ES module (virtual or not) has no location on Node and workerd. Node only prints it for uncaught errors (a hidden "arrow message"), so a worker that catches the error can't name the module.
  - Bun and miniflare link errors name only the imported module, and workerd's JSON errors name nothing.
  - `reloadModule()` errors keep the plain message.

## Testing

- `test/virtual.test.ts` covers all IPC runners + miniflare (imports, virtual entry, a 1 MiB source beyond env limits, TS/JSON, factories, invalidation incl. via an intermediate importer, reload, shutdown, miniflare-specific rewrite/persistent/exports cases, `SelfEnvRunner` rejection). Attribute-using JSON cases run on Node/Bun only.
- Path key cases use keys under `test/fixtures/virtual-paths/virtual/`, a directory that doesn't exist, next to real fixtures in `test/fixtures/virtual-paths/` (`app.mjs` imports `./config.mjs`; `helper.mjs`). They cover:
  - relative virtual→virtual imports;
  - `file:` keys;
  - overriding a real file imported by a disk module;
  - real-file and bare imports;
  - `import.meta`;
  - invalidation through relative intermediate importers.

  Miniflare skips the cases it doesn't support, each with a comment. Miniflare-only path cases: `file:` imports redirected to one instance (also after invalidation), invalidation of an override imported by the disk entry, and auto-wired DO exports of a `#`/path-keyed virtual entry.

- The "disk importers" block uses `test/fixtures/virtual-importers/`: `app.mjs` → `./lib.mjs` → `./deep.mjs` → `#count`, plus `./unrelated.mjs`, and both chains import `./shared.mjs`. Each module counts its evaluations in `globalThis.__evaluations`. It asserts:
  - only the importer chain is re-evaluated, both from a disk entry and from a path-keyed virtual entry;
  - a reloaded disk entry picks up an invalidated virtual import (on every runner).

  Bun and miniflare skip the chain cases: without resolve hooks, the chain stays stale there.

- The "entry spelling" block (Node/Deno runners) covers a path entry for a `file:` key and the reverse, with a real `app.mjs` at that path, across reload and invalidation. "virtual entry detection" unit-tests `isVirtualSpecifier()` (exact by default, or with `matchPaths`) and `isVirtualEntry()`.

- `?query` cases: a query on keys with an extension (all runners) and on an extensionless key (skipped on Bun, see [Bun](#bun-bunplugin-onresolveonload--buildmodule)).
- Non-path key ids: "serves non-path keys under a readable `virtual:` URL" (Node/Deno runners) checks `import.meta.url` and a real stack frame. "virtual: URLs of non-path keys" unit-tests the `createVirtualHooks()` URLs: readable, normalized (`new URL(url).href`), mapped back to the key, versioned after the query, and malformed escapes passed on.
- Collisions: "warns about path keys naming the same file" (all runners) spies on the host's `console.warn`. "warnVirtualPathCollisions" unit-tests once-per-pair, normalized paths, and keys that must not warn.
- Error messages: "names the virtual module that throws during init" / "... TypeScript module that fails to parse" / "... JSON module that fails to parse" check the close cause on each runner (JSON skipped on miniflare). "formatInitError" unit-tests the error shapes of each runtime.
- Runner tests spawn workers from `dist/` (via the self-linked `env-runner` package), so run `pnpm build` after worker-side changes.
- Bun/Deno suites auto-skip when the binary is missing. Old-Deno TS fail-fast is detected by probing `deno eval` at collection time.
- vitest runs on Node, so node-worker/node-process on a **Bun host** (Bun backend) aren't covered by the suite. Check them with a small script run by `bun` against `dist/`.
- `test/fixtures/virtual-unregister.mjs` runs as a node/bun **subprocess** because vitest's module runner intercepts in-process dynamic imports. It covers unregister on both backends, including a path key overriding a real file. `test/fixtures/virtual-registrations.mjs` (same setup) covers stacked registrations: latest wins, a per-registration update, and unregistering uncovers the older one.
- `test/fixtures/app-virtual.mjs` is an entry importing `#virtual-message`.
- The "virtual module updates" block runs on every runner (none skipped, except the disk-importer case on Bun/miniflare, like the "disk importers" block). Entries import through `import(...).then(..., () => "missing")`, so a missing module reads as `"missing"`, also for miniflare's `undefined` stub. It covers:
  - adding a `#` key that an intermediate importer failed to link, and a path key a relative import didn't find;
  - overriding a real file imported by the disk entry (from a runner started without `data.virtual`), the disk entry itself, and a file overridden from the start, then removing the key to uncover the file;
  - replacing a string source behind relative importers, removing a key (not found), a batch with one ack, TS/JSON additions, a factory set by an update and re-run by `invalidateModule()`;
  - call order behind a slower factory, an update before ready, no leak into `ipc.onMessage`, and the caller's `data.virtual` left untouched;
  - miniflare `persistent` sharing and eviction, and `SelfEnvRunner` rejection.

  `test/manager.test.ts` and `test/server.test.ts` cover the automatic reload, and `EnvServer` restarting from the updated map. On a Bun host, the node-worker/node-process update paths were checked with a script against `dist/`.

- The "virtual module formats" block runs on every runner. It covers an explicit format on extensionless keys (`json`, `module-typescript`), CommonJS default and named exports (`.cjs` and explicit), `.cts`, `require()` of virtual modules (path and `#` keys; skipped on Deno), updating modules required by CommonJS (skipped on Deno and miniflare, see [CommonJS](#commonjs)), updating a path-keyed `.cjs` module imported by an ES module (Node's eviction, Deno's `virtual:` URL), overriding a real `.cjs` file (`test/fixtures/virtual-paths/legacy.cjs`, imported by `app-cjs.mjs`) and uncovering it again, text, bytes round-tripped at startup and through an update (every byte value), Wasm instantiated at startup and after an update, invalidating a text factory through an intermediate importer, JSX/TSX on Bun and the error elsewhere (at startup and on update), and the host's format errors. "virtual module sources" unit-tests the format defaults, normalization and its errors, the JSON round trip, and the code-only quoted scan. A miniflare case checks that `persistent` instances are shared only for identical bytes. On a Bun host, node-worker/node-process were checked with every format (JSX included) by a script against `dist/`.
