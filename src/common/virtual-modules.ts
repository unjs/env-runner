import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVirtualHooks,
  expandVirtualInvalidation,
  stripVirtualTypeScript,
  virtualKeyURL,
  virtualModuleFormat,
} from "../virtual-loader.ts";

/**
 * Serve virtual modules; await before importing the entry. Format follows the
 * extension ({@link virtualModuleFormat}); Deno sources are pre-transformed.
 *
 * Backends: `module.registerHooks` (Node >= 22.15 / 23.5, Deno), imported
 * dynamically since a static named import fails to link where it's missing;
 * or `Bun.plugin` (Bun's `module.register` is a silent no-op). Warns once and
 * skips when neither exists.
 *
 * Resolves to an idempotent unregister function. Bun can't remove plugins, so
 * there it detaches the registration (cached modules survive, fresh loads fail
 * or fall through to disk). An empty map registers nothing until
 * {@link updateVirtualModules} adds a key; its unregister covers that.
 */
export async function registerVirtualModules(
  virtual?: Record<string, string>,
): Promise<() => void> {
  if (!virtual || Object.keys(virtual).length === 0) {
    return _once(() => {
      for (const unregister of _lazyUnregisters.splice(0)) {
        unregister();
      }
    });
  }
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  if (typeof registerHooks === "function") {
    const isDeno = "Deno" in globalThis;
    let transformSource: ((specifier: string, source: string) => string) | undefined;
    if (isDeno) {
      transformSource = (specifier, source) =>
        _transformSourceForDeno(specifier, source, stripTypeScriptTypes);
      const transformed: Record<string, string> = {};
      for (const [specifier, source] of Object.entries(virtual)) {
        transformed[specifier] = transformSource(specifier, source);
      }
      virtual = transformed;
    }
    const versions = new Map<string, number>();
    const importers = new Map<string, Set<string>>();
    // Track only after registerHooks succeeds (a throw returns no unregister).
    // Deno sources are already plain JS, so force the `module` format.
    const { resolve, load, updateKeys } = createVirtualHooks(virtual, {
      versions,
      importers,
      forcePlainModule: isDeno,
    });
    const hooks = registerHooks({ resolve, load });
    const registration: HooksRegistration = {
      virtual,
      versions,
      version: 0,
      importers,
      transformSource,
      updateKeys,
    };
    _hooksRegistrations.unshift(registration);
    return _once(() => {
      const index = _hooksRegistrations.indexOf(registration);
      if (index !== -1) {
        _hooksRegistrations.splice(index, 1);
      }
      hooks.deregister();
    });
  }
  if (typeof (globalThis as any).Bun?.plugin === "function") {
    const { createRequire } = await import("node:module");
    const registration = _createBunRegistration(virtual, createRequire(import.meta.url).cache);
    // One plugin per registration: reloads and invalidation never add another.
    (globalThis as any).Bun.plugin({
      name: "env-runner-virtual",
      setup: (build: any) => _setupBunPlugin(build, registration),
    });
    _bunRegistrations.unshift(registration);
    return _once(() => {
      const index = _bunRegistrations.indexOf(registration);
      if (index !== -1) {
        _bunRegistrations.splice(index, 1);
      }
      // Its `onLoad` filters stay installed, so its paths resolve to the real
      // files from now on (like a removed key).
      for (const path of [...registration.paths.keys(), ...registration.removed.keys()]) {
        _bunReleasedPaths.add(path);
      }
    });
  }
  console.warn(
    "[env-runner] virtual modules require `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.8) or `Bun.plugin`; skipping registration.",
  );
  return _noop;
}

/**
 * Bust a Bun virtual module's cache so the next import of `specifier` itself
 * evaluates fresh (a `?query` suffix can't do it: Bun only calls `onResolve`
 * for some specifiers). Its imports stay cached, like on `registerHooks`.
 * `false` when not Bun-registered.
 */
export function refreshVirtualModule(specifier: string): boolean {
  for (const registration of _bunRegistrations) {
    if (Object.hasOwn(registration.virtual, specifier)) {
      _bustBunModules(registration, [specifier]);
      return true;
    }
  }
  return false;
}

/**
 * Set (string source) or remove (`null`) virtual modules in one step. A key
 * changes in the registration serving it and a new key goes to the latest one,
 * registering one if there is none. Changed keys and their importers (see
 * {@link expandVirtualInvalidation}; with `registerHooks` also disk ES modules)
 * evaluate fresh on their next import. Linked importers keep their instances,
 * so pair with `reloadModule()`. A removed key falls through to normal
 * resolution: the real file it overrode, or not found. If a source can't be
 * prepared (Deno type stripping), nothing changes.
 */
export async function updateVirtualModules(changes: Record<string, string | null>): Promise<void> {
  if (_hooksRegistrations.length === 0 && _bunRegistrations.length === 0) {
    const added = Object.fromEntries(
      Object.entries(changes).filter((entry): entry is [string, string] => entry[1] !== null),
    );
    if (Object.keys(added).length === 0) {
      return;
    }
    // Registered with the added keys, then updated below like any registration,
    // which versions them: their paths may be cached from disk.
    const unregister = await registerVirtualModules(added);
    if (_hooksRegistrations.length === 0 && _bunRegistrations.length === 0) {
      throw new Error("Cannot update virtual modules: this runtime can't serve them");
    }
    _lazyUnregisters.push(unregister);
  }
  const registrations: VirtualRegistration[] =
    _hooksRegistrations.length > 0 ? _hooksRegistrations : _bunRegistrations;
  const groups = new Map<VirtualRegistration, Record<string, string | null>>();
  for (const [key, source] of Object.entries(changes)) {
    const owner =
      registrations.find((registration) => Object.hasOwn(registration.virtual, key)) ??
      (source === null ? undefined : registrations[0]!);
    if (owner) {
      let group = groups.get(owner);
      if (!group) {
        groups.set(owner, (group = {}));
      }
      group[key] = source;
    }
  }
  // Prepare every source before changing any registration (Deno can throw).
  const prepared = [...groups].map(([registration, group]) => {
    const transform = "transformSource" in registration && registration.transformSource;
    const sources: Record<string, string | null> = {};
    for (const [key, source] of Object.entries(group)) {
      sources[key] = transform && source !== null ? transform(key, source) : source;
    }
    return [registration, sources] as const;
  });
  for (const [registration, sources] of prepared) {
    if ("updateKeys" in registration) {
      _updateHooksRegistration(registration, sources);
    } else {
      _updateBunRegistration(registration, sources);
    }
  }
}

/**
 * Handle an `update-virtual-modules` IPC message and ack with
 * `virtual-modules-updated` (same `id`). Messages apply in arrival order.
 */
export function handleUpdateVirtualModules(
  message: { id?: unknown; changes?: Record<string, string | null> },
  sendMessage: (message: unknown) => void,
): Promise<void> {
  const update = _pendingUpdate
    .then(() => updateVirtualModules(message.changes ?? {}))
    .then(
      () => sendMessage({ event: "virtual-modules-updated", id: message.id }),
      (error) =>
        sendMessage({
          event: "virtual-modules-updated",
          id: message.id,
          error: error?.message || String(error),
        }),
    );
  _pendingUpdate = update.catch(() => {});
  return _pendingUpdate;
}

/** The live `key => source` view of all registrations (the latest wins), following updates. */
export function registeredVirtualModules(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const registration of [..._hooksRegistrations, ..._bunRegistrations].reverse()) {
    Object.assign(merged, registration.virtual);
  }
  return merged;
}

type VirtualRegistration = HooksRegistration | BunRegistration;

// Serializes `handleUpdateVirtualModules()` (registering can await).
let _pendingUpdate: Promise<void> = Promise.resolve();

// Unregisters of registrations created by `updateVirtualModules()`, run by the
// unregister of an empty `registerVirtualModules()`.
const _lazyUnregisters: (() => void)[] = [];

interface HooksRegistration {
  virtual: Record<string, string>;
  versions: Map<string, number>;
  // Last version handed out: unique per registration, so a key and the disk
  // file it overrides (or uncovers) never share a `?v=<n>` URL.
  version: number;
  // Resolved `module => importers` edges (keys and disk files), recorded by
  // the hooks; `versions` also covers the disk files.
  importers: Map<string, Set<string>>;
  transformSource?: (specifier: string, source: string) => string;
  updateKeys: (keys: Iterable<string>) => void;
}

function _updateHooksRegistration(
  registration: HooksRegistration,
  changes: Record<string, string | null>,
): void {
  const { virtual, versions, importers } = registration;
  const added: string[] = [];
  const removed: string[] = [];
  for (const [key, source] of Object.entries(changes)) {
    if (source === null) {
      removed.push(key);
      continue;
    }
    if (!Object.hasOwn(virtual, key)) {
      added.push(key);
    }
    virtual[key] = source;
  }
  registration.updateKeys(added);
  // Path keys also expand from their file URL, which tracks disk importers of
  // the file an added key now overrides and versions the file a removed key
  // uncovers. Removed keys are still in `virtual` for the quoted scan.
  const targets = Object.keys(changes).flatMap((key) => {
    const url = virtualKeyURL(key);
    return url && url !== key ? [key, url] : [key];
  });
  for (const node of expandVirtualInvalidation(virtual, targets, importers)) {
    versions.set(node, ++registration.version);
  }
  for (const key of removed) {
    delete virtual[key];
  }
  registration.updateKeys(removed);
}

// Live registerHooks registrations, latest first. Registrations stack, so
// invalidation searches all of them (mutating the maps the hooks close over).
const _hooksRegistrations: HooksRegistration[] = [];

/**
 * A `Bun.plugin` registration. Keys are split by how Bun can reach them:
 * - `paths`: path keys, served under their real path (`file` namespace).
 * - `namespaced`: other keys, served in {@link BUN_NAMESPACE}.
 * - `modules`: keys runtime `onResolve` never sees ({@link _bunResolvable}),
 *   matched verbatim by `build.module()`.
 */
interface BunRegistration {
  virtual: Record<string, string>;
  paths: Map<string, string>;
  namespaced: Set<string>;
  modules: Set<string>;
  // Paths of keys added by updates, which no setup `onLoad` filter matches:
  // served with {@link BUN_VIRTUAL_MARKER} for the shared marker `onLoad`.
  dynamic: Set<string>;
  // `path => key` of removed path keys: resolved to the real file under a
  // fresh id with {@link BUN_DISK_MARKER}, until the key is added again.
  removed: Map<string, string>;
  // Bumped to serve a fresh `?v=<n>` identity (`onResolve`-served keys only).
  versions: Map<string, number>;
  // Last version handed out (unique per registration, see `HooksRegistration`).
  version: number;
  // Resolved `key => importer keys` edges, recorded by `onResolve`.
  importers: Map<string, Set<string>>;
  // `key => module ids` served since the last bump, evicted on the next one.
  served: Map<string, Set<string>>;
  // `require.cache`, which also evicts ES modules from Bun's registry.
  cache: Record<string, unknown>;
  // Kept after setup: `build.module()` re-registers without a new plugin.
  build?: any;
}

// Live Bun registrations, latest first. Plugin callbacks dispatch through this
// list, so later registrations win and unregistering detaches one.
const _bunRegistrations: BunRegistration[] = [];

const BUN_NAMESPACE = "env-runner-virtual";

// Leading query params of served path ids. `onLoad` can't decline a module
// (returning nothing throws), so these route by filter instead:
// - virtual marker: matched by the one shared `onLoad` serving keys added by
//   updates (per-update filters would slow down every import, see below).
// - disk marker: excluded from every `onLoad` filter, so Bun loads the real
//   file (any format), or reports it missing.
const BUN_VIRTUAL_MARKER = "__env_runner_virtual";
const BUN_DISK_MARKER = "__env_runner_disk";

// Shared callbacks installed once: `onLoad` for the namespace, and the
// catch-all `onResolve` plus marker `onLoad` for keys added by updates.
let _bunNamespaceLoader = false;
let _bunDynamicCallbacks = false;
// Last segments (`_bunSpecifierName()`) of path and namespaced keys added by
// updates, the catch-all's cheap pre-check. Never shrinks: removed path keys
// still resolve.
const _bunDynamicNames = new Set<string>();
// Paths of unregistered registrations, resolved to the real files.
const _bunReleasedPaths = new Set<string>();

function _createBunRegistration(
  virtual: Record<string, string>,
  cache: Record<string, unknown>,
): BunRegistration {
  const registration: BunRegistration = {
    virtual,
    paths: new Map(),
    namespaced: new Set(),
    modules: new Set(),
    dynamic: new Set(),
    removed: new Map(),
    versions: new Map(),
    version: 0,
    importers: new Map(),
    served: new Map(),
    cache,
  };
  for (const key of Object.keys(virtual)) {
    _addBunKey(registration, key);
  }
  return registration;
}

// Classify a key by how Bun can reach it; `true` for a path key.
function _addBunKey(registration: BunRegistration, key: string): boolean {
  const path = _bunKeyPath(key);
  if (path === undefined) {
    const resolvable = !key.includes(":") && _bunResolvable(key);
    (resolvable ? registration.namespaced : registration.modules).add(key);
    return false;
  }
  if (_bunResolvable(basename(path))) {
    registration.paths.set(path, key);
    registration.removed.delete(path);
    return true;
  }
  registration.modules.add(key);
  return false;
}

function _setupBunPlugin(build: any, registration: BunRegistration): void {
  registration.build = build;
  // Native filters keep unrelated imports off the JS callbacks: namespaced keys
  // verbatim, path keys by basename (absolute, relative and served forms).
  const query = String.raw`(?:\?.*)?$`;
  const resolveFilters = [
    ...[...registration.namespaced].map((key) => `^${_escapeRegExp(key)}${query}`),
    ...[...registration.paths.keys()].map(
      (path) => String.raw`(?:^|[\\/])${_escapeRegExp(basename(path))}${query}`,
    ),
  ];
  if (resolveFilters.length > 0) {
    build.onResolve({ filter: new RegExp(resolveFilters.join("|")) }, _resolveBunModule);
  }
  if (registration.paths.size > 0) {
    const paths = [...registration.paths.keys()].map(_escapeRegExp).join("|");
    const loadQuery = String.raw`(?:\?(?!${BUN_DISK_MARKER}(?:&|$)).*)?$`;
    build.onLoad({ filter: new RegExp(`^(?:${paths})${loadQuery}`) }, _loadBunPath);
  }
  if (registration.namespaced.size > 0 && !_bunNamespaceLoader) {
    _bunNamespaceLoader = true;
    build.onLoad({ filter: /.*/, namespace: BUN_NAMESPACE }, _loadBunNamespaced);
  }
  for (const key of registration.modules) {
    build.module(key, () => _loadBunModule(key));
  }
}

// Setup filters only match the keys a registration started with. Keys added
// later go through a catch-all `onResolve` and a marker `onLoad`, added once
// through a saved builder (it still works after `setup()` returns), so the
// callback count doesn't grow with updates. Measured on Bun 1.4.2 over 4000
// disk module loads: one filter pair per update batch would cost ~0.4 µs per
// load per batch (100 batches: 49 → 80 µs per load; 1000: 470 µs), while the
// catch-all costs 49 → 52 µs for any batch count (56 µs without its pre-check).
function _installBunDynamicCallbacks(build: any): void {
  if (!_bunDynamicCallbacks) {
    _bunDynamicCallbacks = true;
    build.onResolve({ filter: /.*/ }, _resolveBunDynamic);
    const marker = new RegExp(String.raw`\?${BUN_VIRTUAL_MARKER}(?:&|$)`);
    build.onLoad({ filter: marker }, _loadBunPath);
  }
  if (!_bunNamespaceLoader) {
    _bunNamespaceLoader = true;
    build.onLoad({ filter: /.*/, namespace: BUN_NAMESPACE }, _loadBunNamespaced);
  }
}

function _updateBunRegistration(
  registration: BunRegistration,
  changes: Record<string, string | null>,
): void {
  const { virtual } = registration;
  const removed: string[] = [];
  let dynamic = false;
  for (const [key, source] of Object.entries(changes)) {
    if (source === null) {
      removed.push(key);
      continue;
    }
    if (!Object.hasOwn(virtual, key)) {
      const path = _bunKeyPath(key);
      if (_addBunKey(registration, key)) {
        registration.dynamic.add(path!);
        _bunDynamicNames.add(_bunSpecifierName(path!));
      } else if (registration.namespaced.has(key)) {
        _bunDynamicNames.add(_bunSpecifierName(key));
      }
      dynamic ||= !registration.modules.has(key);
    }
    virtual[key] = source;
  }
  if (dynamic) {
    _installBunDynamicCallbacks(registration.build);
  }
  // Removed keys are still in `virtual` for the quoted scan. Busting also
  // registers added `build.module()` keys.
  _bustBunModules(
    registration,
    expandVirtualInvalidation(virtual, Object.keys(changes), registration.importers),
  );
  for (const key of removed) {
    _removeBunKey(registration, key);
  }
}

function _removeBunKey(registration: BunRegistration, key: string): void {
  const { virtual, paths } = registration;
  delete virtual[key];
  registration.namespaced.delete(key);
  // A `build.module()` can't be unregistered: fresh loads throw.
  registration.modules.delete(key);
  const path = _bunKeyPath(key);
  if (path === undefined || paths.get(path) !== key) {
    return;
  }
  paths.delete(path);
  registration.dynamic.delete(path);
  registration.removed.set(path, key);
  // Another key naming the same file (the latest) takes over.
  for (const other of Object.keys(virtual)) {
    if (_bunKeyPath(other) === path) {
      paths.set(path, other);
      registration.removed.delete(path);
    }
  }
}

// Bun passes `file:` specifiers as paths, and calls `onResolve` again on the
// path it returned (with an empty importer), so the result must be stable.
function _resolveBunModule(args: { path: string; importer: string }) {
  const specifier = _stripQuery(args.path);
  const query = _stripBunMarker(args.path.slice(specifier.length));
  let path: string | undefined;
  if (isAbsolute(specifier)) {
    path = resolve(specifier);
  } else if (/^\.\.?[\\/]/.test(specifier)) {
    path = resolve(_bunImporterDir(args.importer), specifier);
  }
  for (const registration of _bunRegistrations) {
    const namespaced = registration.namespaced.has(specifier);
    const key = namespaced ? specifier : path && registration.paths.get(path);
    if (!key) {
      continue;
    }
    _addBunImporter(registration, key, args.importer);
    const marker = !namespaced && registration.dynamic.has(path!) ? BUN_VIRTUAL_MARKER : undefined;
    const served = _bunVersioned(
      (namespaced ? specifier : path) + _withBunMarker(query, marker),
      registration.versions.get(key),
    );
    _addToSetMap(registration.served, key, namespaced ? `${BUN_NAMESPACE}:${served}` : served);
    return namespaced ? { path: served, namespace: BUN_NAMESPACE } : { path: served };
  }
  // A removed path key: the real file (or not found), under a fresh id, since
  // the key's module may be cached under the plain path.
  for (const registration of _bunRegistrations) {
    const key = path && registration.removed.get(path);
    if (!key) {
      continue;
    }
    // Recorded for a later re-add.
    _addBunImporter(registration, key, args.importer);
    const served = _bunVersioned(
      path + _withBunMarker(query, BUN_DISK_MARKER),
      registration.versions.get(key),
    );
    _addToSetMap(registration.served, key, served);
    return { path: served };
  }
  if (path && _bunReleasedPaths.has(path)) {
    return { path: path + _withBunMarker(query, BUN_DISK_MARKER) };
  }
  return undefined;
}

// The catch-all only resolves specifiers named like a key added by an update,
// sparing every other import the full resolution.
function _resolveBunDynamic(args: { path: string; importer: string }) {
  const name = _bunSpecifierName(_stripQuery(args.path));
  return _bunDynamicNames.has(name) ? _resolveBunModule(args) : undefined;
}

// Last segment of a path or specifier (`#dir/x.mjs` → `x.mjs`).
function _bunSpecifierName(specifier: string): string {
  return specifier.slice(Math.max(specifier.lastIndexOf("/"), specifier.lastIndexOf("\\")) + 1);
}

function _addBunImporter(registration: BunRegistration, key: string, importerId: string): void {
  const importer = _bunKeyOf(registration, importerId);
  if (importer !== undefined && importer !== key) {
    _addToSetMap(registration.importers, key, importer);
  }
}

// Markers lead the query, so the import's own query follows them.
function _withBunMarker(query: string, marker: string | undefined): string {
  if (!marker) {
    return query;
  }
  return `?${marker}` + (query ? `&${query.slice(1)}` : "");
}

function _stripBunMarker(query: string): string {
  for (const marker of [BUN_VIRTUAL_MARKER, BUN_DISK_MARKER]) {
    if (query === `?${marker}`) {
      return "";
    }
    if (query.startsWith(`?${marker}&`)) {
      return `?${query.slice(marker.length + 2)}`;
    }
  }
  return query;
}

function _loadBunPath(args: { path: string }) {
  const path = _stripQuery(args.path);
  for (const registration of _bunRegistrations) {
    const key = registration.paths.get(path);
    if (key !== undefined) {
      return _serveBunModule(key, registration.virtual[key]);
    }
  }
  // Unregistered: load the real file the key overrode (if any) from disk.
  return undefined;
}

function _loadBunNamespaced(args: { path: string }) {
  const key = _stripQuery(args.path);
  const registration = _bunRegistrations.find((r) => r.namespaced.has(key));
  return _serveBunModule(key, registration?.virtual[key]);
}

function _loadBunModule(key: string) {
  const registration = _bunRegistrations.find((r) => r.modules.has(key));
  return _serveBunModule(key, registration?.virtual[key]);
}

function _serveBunModule(key: string, source: string | undefined) {
  if (source === undefined) {
    throw new Error(`Cannot find virtual module "${key}" (unregistered)`);
  }
  const format = virtualModuleFormat(key);
  if (format === "json") {
    // Bun's runtime `json` loader doesn't parse contents.
    return { exports: { default: _parseBunJSON(key, source) }, loader: "object" };
  }
  return { contents: source, loader: format === "module-typescript" ? "ts" : "js" };
}

// Names the key, as Node's JSON errors do (Bun's parse error has no location).
function _parseBunJSON(key: string, source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error: any) {
    const message = `[env-runner] invalid JSON in virtual module "${key}": ${error?.message}`;
    throw new SyntaxError(message, { cause: error });
  }
}

// Versioned keys get a fresh `?v=<n>` identity, and their superseded ids are
// evicted so replaced instances don't pile up in Bun's registry (best effort:
// undocumented, so correctness relies on the version). `build.module()` keys
// can't carry a query: re-registering one evicts it.
function _bustBunModules(registration: BunRegistration, keys: string[]): void {
  for (const key of keys) {
    if (registration.modules.has(key)) {
      registration.build.module(key, () => _loadBunModule(key));
      continue;
    }
    registration.versions.set(key, ++registration.version);
    for (const id of registration.served.get(key) ?? []) {
      delete registration.cache[id];
    }
    registration.served.delete(key);
  }
}

// Idempotent, since Bun re-resolves the returned id.
function _bunVersioned(id: string, version: number | undefined): string {
  const param = `v=${version}`;
  if (!version || id.endsWith(`?${param}`) || id.endsWith(`&${param}`)) {
    return id;
  }
  return id + (id.includes("?") ? "&" : "?") + param;
}

// Path of a path key (absolute path or `file:` URL), else `undefined`.
function _bunKeyPath(key: string): string | undefined {
  if (key.startsWith("file:")) {
    try {
      return fileURLToPath(key);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(key) ? resolve(key) : undefined;
}

// Registered key of an importer id: a served path, a `namespace:key` or a
// `build.module()` specifier.
function _bunKeyOf(registration: BunRegistration, importer: string): string | undefined {
  const prefix = `${BUN_NAMESPACE}:`;
  const id = _stripQuery(importer.startsWith(prefix) ? importer.slice(prefix.length) : importer);
  return registration.paths.get(id) ?? (Object.hasOwn(registration.virtual, id) ? id : undefined);
}

// Imports from non-path modules (namespaced or `build.module()`) resolve from
// cwd, like Bun does for them and like `registerHooks` re-bases them.
function _bunImporterDir(importer: string): string {
  const path = _stripQuery(importer);
  return isAbsolute(path) ? dirname(path) : process.cwd();
}

// Bun calls runtime `onResolve` only when a specifier's last `.` is followed
// by a letter or non-ASCII char, or for `namespace:` specifiers (routed to
// that namespace). Others (`#name`, bare) only reach `build.module()`.
function _bunResolvable(specifier: string): boolean {
  const dot = specifier.lastIndexOf(".");
  const code = dot === -1 ? 0 : specifier.charCodeAt(dot + 1);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
}

function _stripQuery(specifier: string): string {
  const qIndex = specifier.indexOf("?");
  return qIndex === -1 ? specifier : specifier.slice(0, qIndex);
}

function _addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    map.set(key, (set = new Set()));
  }
  set.add(value);
}

function _escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

// Deno parses every hook-loaded source as JS regardless of `format`. It skips
// import attribute checks there, so `with { type: "json" }` still works.
// `stripTypeScriptTypes` needs Deno >= 2.8.2.
function _transformSourceForDeno(
  specifier: string,
  source: string,
  stripTypeScriptTypes?: (code: string) => string,
): string {
  const format = virtualModuleFormat(specifier);
  if (format === "module-typescript") {
    return stripVirtualTypeScript(specifier, source, stripTypeScriptTypes, {
      requirement: "(custom load hooks bypass Deno's native type stripping)",
      remedy: "upgrade Deno",
    });
  }
  if (format === "json") {
    return `export default JSON.parse(${JSON.stringify(source)});`;
  }
  return source;
}

const _noop = () => {};

function _once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
}
