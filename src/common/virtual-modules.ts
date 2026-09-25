import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVirtualHooks,
  expandVirtualInvalidation,
  stripVirtualTypeScript,
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
 * or fall through to disk).
 */
export async function registerVirtualModules(
  virtual?: Record<string, string>,
): Promise<() => void> {
  if (!virtual || Object.keys(virtual).length === 0) {
    return _noop;
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
    const registration: HooksRegistration = {
      virtual,
      versions: new Map(),
      importers: new Map(),
      transformSource,
    };
    // Track only after registerHooks succeeds (a throw returns no unregister).
    // Deno sources are already plain JS, so force the `module` format.
    const hooks = registerHooks(
      createVirtualHooks(virtual, {
        versions: registration.versions,
        importers: registration.importers,
        forcePlainModule: isDeno,
      }),
    );
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
 * Make the next import of a virtual module (and its importers, see
 * {@link expandVirtualInvalidation}; with `registerHooks` also disk ES modules)
 * evaluate fresh, optionally replacing its source. Linked importers keep their
 * instances; pair with `reloadModule()`.
 */
export function invalidateVirtualModule(specifier: string, source?: string): boolean {
  for (const registration of _hooksRegistrations) {
    if (!Object.hasOwn(registration.virtual, specifier)) {
      continue;
    }
    const { virtual, versions, importers, transformSource } = registration;
    if (source !== undefined) {
      virtual[specifier] = transformSource ? transformSource(specifier, source) : source;
    }
    for (const key of expandVirtualInvalidation(virtual, specifier, importers)) {
      versions.set(key, (versions.get(key) ?? 0) + 1);
    }
    return true;
  }
  for (const registration of _bunRegistrations) {
    if (!Object.hasOwn(registration.virtual, specifier)) {
      continue;
    }
    const { virtual, importers } = registration;
    if (source !== undefined) {
      virtual[specifier] = source;
    }
    _bustBunModules(registration, expandVirtualInvalidation(virtual, specifier, importers));
    return true;
  }
  return false;
}

/** Handle an `invalidate-module` IPC message and ack with `module-invalidated`. */
export function handleInvalidateModule(
  message: { specifier: string; source?: string },
  sendMessage: (message: unknown) => void,
): void {
  const ok = invalidateVirtualModule(message.specifier, message.source);
  sendMessage({
    event: "module-invalidated",
    specifier: message.specifier,
    error: ok
      ? undefined
      : `Cannot invalidate "${message.specifier}" (not a registered virtual module)`,
  });
}

interface HooksRegistration {
  virtual: Record<string, string>;
  versions: Map<string, number>;
  // Resolved `module => importers` edges (keys and disk files), recorded by
  // the hooks; `versions` also covers the disk files.
  importers: Map<string, Set<string>>;
  transformSource?: (specifier: string, source: string) => string;
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
  // Bumped to serve a fresh `?v=<n>` identity (`onResolve`-served keys only).
  versions: Map<string, number>;
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

function _createBunRegistration(
  virtual: Record<string, string>,
  cache: Record<string, unknown>,
): BunRegistration {
  const registration: BunRegistration = {
    virtual,
    paths: new Map(),
    namespaced: new Set(),
    modules: new Set(),
    versions: new Map(),
    importers: new Map(),
    served: new Map(),
    cache,
  };
  for (const key of Object.keys(virtual)) {
    const path = _bunKeyPath(key);
    if (path === undefined) {
      const resolvable = !key.includes(":") && _bunResolvable(key);
      (resolvable ? registration.namespaced : registration.modules).add(key);
    } else if (_bunResolvable(basename(path))) {
      registration.paths.set(path, key);
    } else {
      registration.modules.add(key);
    }
  }
  return registration;
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
    build.onLoad({ filter: new RegExp(`^(?:${paths})${query}`) }, _loadBunPath);
  }
  if (registration.namespaced.size > 0) {
    build.onLoad({ filter: /.*/, namespace: BUN_NAMESPACE }, _loadBunNamespaced);
  }
  for (const key of registration.modules) {
    build.module(key, () => _loadBunModule(key));
  }
}

// Bun passes `file:` specifiers as paths, and calls `onResolve` again on the
// path it returned (with an empty importer), so the result must be stable.
function _resolveBunModule(args: { path: string; importer: string }) {
  const specifier = _stripQuery(args.path);
  const query = args.path.slice(specifier.length);
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
    const importer = _bunKeyOf(registration, args.importer);
    if (importer !== undefined && importer !== key) {
      _addToSetMap(registration.importers, key, importer);
    }
    const served = _bunVersioned(
      (namespaced ? specifier : path) + query,
      registration.versions.get(key),
    );
    _addToSetMap(registration.served, key, namespaced ? `${BUN_NAMESPACE}:${served}` : served);
    return namespaced ? { path: served, namespace: BUN_NAMESPACE } : { path: served };
  }
  return undefined;
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
    registration.versions.set(key, (registration.versions.get(key) ?? 0) + 1);
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
