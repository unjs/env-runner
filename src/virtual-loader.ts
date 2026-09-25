import type { ResolveHookSync, LoadHookSync, ResolveHookContext } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** Factories run once on the host, before the worker spawns. */
export type VirtualModuleSource = string | (() => string | Promise<string>);

/** Virtual modules as a `specifier => source` map. */
export type VirtualModules = Record<string, VirtualModuleSource>;

/** Changes to apply to a running map: a source sets (adds or replaces) a key, `null` removes it. */
export type VirtualModuleUpdates = Record<string, VirtualModuleSource | null>;

/** Resolve factory sources to strings (safe to pass to workers and {@link createVirtualHooks}). */
export async function resolveVirtualModules(
  virtual: VirtualModules,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(virtual).map(
      async ([key, value]) => [key, typeof value === "function" ? await value() : value] as const,
    ),
  );
  return Object.fromEntries(entries);
}

const VIRTUAL_SCHEME = "virtual:";

export interface VirtualHooksOptions {
  /**
   * Per-module versions, appended as `?v=<n>` for a fresh identity
   * (invalidation). Modules are keys, or disk files by bare `file:` URL.
   */
  versions?: ReadonlyMap<string, number>;
  /**
   * Filled with `module => importers` edges seen while resolving. Modules are
   * keys, or disk files by bare `file:` URL; importers are keys, or ES module
   * files loaded through these hooks (never the code that imported the entry).
   */
  importers?: Map<string, Set<string>>;
  /** Resolution base for imports from non-path virtual modules (default: cwd). */
  baseURL?: string;
  /**
   * For backends that pre-transform sources to JS (Deno >= 2.9 honors the
   * format and would re-parse them as JSON/TS).
   */
  forcePlainModule?: boolean;
}

/**
 * `module.registerHooks()` hooks serving virtual modules from resolved string
 * sources (the sync load hook can't await a factory).
 *
 * Path keys (absolute paths, `file:` URLs) are served under their own `file:`
 * URL and match any import resolving to it, so their own imports resolve like
 * a real file at that path. Other keys match the import specifier verbatim and
 * are served under a readable `virtual:<key>` URL.
 */
export function createVirtualHooks(
  virtual: Record<string, string>,
  opts: VirtualHooksOptions = {},
): {
  resolve: ResolveHookSync;
  load: LoadHookSync;
  /**
   * Re-index keys added to or removed from `virtual` in place. Sources are
   * read live, so replacing one needs no call.
   */
  updateKeys: (keys: Iterable<string>) => void;
} {
  const { versions, importers, forcePlainModule } = opts;
  const baseURL = opts.baseURL ?? _defaultBaseURL();
  const keyURLs = new Map<string, string>();
  const urlKeys = new Map<string, string>();
  for (const key of Object.keys(virtual)) {
    const url = _virtualKeyURL(key);
    if (url) {
      keyURLs.set(key, url);
      urlKeys.set(url, key);
    }
  }

  // Registered key of a served URL (`virtual:` or path key `file:` URL).
  const keyOf = (url: string): string | undefined => {
    if (url.startsWith(VIRTUAL_SCHEME)) {
      const key = _virtualURLKey(url);
      return key !== undefined && Object.hasOwn(virtual, key) ? key : undefined;
    }
    return urlKeys.size > 0 && url.startsWith("file:") ? urlKeys.get(_bareURL(url)) : undefined;
  };

  // Bare URLs of ES module files loaded through these hooks, i.e. after
  // registration: the entry's graph, not the worker importing it, so importer
  // walks stop at the entry. CommonJS is left out: it's cached by filename, so a
  // version query can't re-evaluate it (Deno reports no format at all).
  const moduleFiles = importers && new Set<string>();

  const track = (node: string, context: ResolveHookContext) => {
    const { parentURL } = context;
    if (!importers || !parentURL) {
      return;
    }
    let importer = keyOf(parentURL);
    // `require()` ignores the version query (Node's cache is by filename).
    if (importer === undefined && !context.conditions?.includes("require")) {
      const file = _bareURL(parentURL);
      importer = moduleFiles!.has(file) ? file : undefined;
    }
    if (importer !== undefined && importer !== node) {
      let set = importers.get(node);
      if (!set) {
        importers.set(node, (set = new Set()));
      }
      set.add(importer);
    }
  };

  const serve = (key: string, url: string, context: ResolveHookContext) => {
    track(key, context);
    const version = versions?.get(key);
    return { url: version ? _appendQuery(url, `v=${version}`) : url, shortCircuit: true };
  };

  const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
    // Strip a cache-busting `?query` suffix (used by reload) before matching, but
    // keep it in the URL so each reload yields a distinct module identity.
    const key = _stripQuery(specifier);
    if (Object.hasOwn(virtual, key)) {
      const keyURL = keyURLs.get(key);
      const url = keyURL ? keyURL + specifier.slice(key.length) : _virtualURL(specifier);
      return serve(key, url, context);
    }
    // `virtual:` is opaque, so default resolution throws building a base from it
    // (`getPackageScopeConfig`); re-base on a real directory.
    const parentURL = context.parentURL?.startsWith(VIRTUAL_SCHEME) ? baseURL : context.parentURL;
    if (urlKeys.size > 0) {
      // Resolved here, since default resolution throws for files not on disk.
      const url = _resolvePathSpecifier(specifier, parentURL);
      const pathKey = url && urlKeys.get(_bareURL(url));
      if (pathKey) {
        return serve(pathKey, url, context);
      }
    }
    const result = nextResolve(
      specifier,
      parentURL === context.parentURL ? context : { ...context, parentURL },
    );
    // Bare or `#imports` specifiers resolving onto an existing overridden file.
    const resolvedKey = urlKeys.size > 0 ? urlKeys.get(_bareURL(result.url)) : undefined;
    if (resolvedKey) {
      return serve(resolvedKey, result.url, context);
    }
    // A disk file: versioned once it (transitively) imports an invalidated key.
    if (result.url.startsWith("file:")) {
      const file = _bareURL(result.url);
      track(file, context);
      const version = versions?.get(file);
      if (version) {
        return { ...result, url: _appendQuery(result.url, `v=${version}`) };
      }
    }
    return result;
  };

  const load: LoadHookSync = (url, context, nextLoad) => {
    const key = keyOf(url);
    if (key !== undefined) {
      return {
        format: forcePlainModule ? "module" : virtualModuleFormat(key),
        source: virtual[key],
        shortCircuit: true,
      };
    }
    const result = nextLoad(url, context);
    if (moduleFiles && url.startsWith("file:") && _isModuleFormat(result.format)) {
      moduleFiles.add(_bareURL(url));
    }
    return result;
  };

  const updateKeys = (keys: Iterable<string>) => {
    for (const key of keys) {
      const url = keyURLs.get(key) ?? _virtualKeyURL(key);
      if (!url) {
        continue;
      }
      if (Object.hasOwn(virtual, key)) {
        // An added key is the latest, so it wins the URL.
        keyURLs.set(key, url);
        urlKeys.set(url, key);
        continue;
      }
      keyURLs.delete(key);
      if (urlKeys.get(url) === key) {
        urlKeys.delete(url);
        // Another key naming the same file (the latest) takes over.
        for (const [other, otherURL] of keyURLs) {
          if (otherURL === url) {
            urlKeys.set(url, other);
          }
        }
      }
    }
  };

  return { resolve, load, updateKeys };
}

/** Format by extension (`module-typescript` is native on Node >= 22.18 / 23.6). */
export function virtualModuleFormat(specifier: string): "module" | "module-typescript" | "json" {
  if (specifier.endsWith(".json")) {
    return "json";
  }
  if (specifier.endsWith(".ts") || specifier.endsWith(".mts")) {
    return "module-typescript";
  }
  return "module";
}

/** For backends that can't parse TypeScript (Deno load hooks, workerd). */
export function stripVirtualTypeScript(
  specifier: string,
  source: string,
  stripTypeScriptTypes: ((code: string) => string) | undefined,
  hints: { requirement: string; remedy: string },
): string {
  if (typeof stripTypeScriptTypes !== "function") {
    throw new TypeError(
      `[env-runner] virtual TypeScript module "${specifier}" requires \`module.stripTypeScriptTypes\` ${hints.requirement}; ${hints.remedy} or provide a pre-transpiled JavaScript source instead.`,
    );
  }
  try {
    return stripTypeScriptTypes(source);
  } catch (error: any) {
    // The stripper only sees the code, so its errors don't say which module.
    throw new SyntaxError(
      `[env-runner] failed to strip types from virtual module "${specifier}": ${error?.message || error}`,
      { cause: error },
    );
  }
}

/**
 * Include transitive importers, else a cached importer still links the old
 * module. Walks the resolved `importers` edges (see
 * {@link VirtualHooksOptions.importers}), which may add disk files by bare
 * `file:` URL, plus a quoted scan of the sources for each key, a fallback for
 * imports that record no edge (Bun `build.module()` keys). Over-matching only
 * forces a re-evaluation. Several specifiers expand in one walk.
 */
export function expandVirtualInvalidation(
  virtual: Record<string, string>,
  specifier: string | Iterable<string>,
  importers?: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const invalidated = [...new Set(typeof specifier === "string" ? [specifier] : specifier)];
  const seen = new Set(invalidated);
  const add = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      invalidated.push(key);
    }
  };
  for (const target of invalidated) {
    for (const key of importers?.get(target) ?? []) {
      add(key);
    }
    // Disk files are only reachable through resolved edges.
    if (!Object.hasOwn(virtual, target)) {
      continue;
    }
    const refs = [`"${target}"`, `'${target}'`, "`" + target + "`"];
    for (const [key, source] of Object.entries(virtual)) {
      if (refs.some((ref) => source.includes(ref))) {
        add(key);
      }
    }
  }
  return invalidated;
}

/**
 * Path key naming the same file as an absolute path or `file:` URL specifier
 * (`/app/x.mjs` finds `file:///app/x.mjs` and the reverse), ignoring its query,
 * like the resolve hook's URL match. `undefined` for other specifiers.
 */
export function findVirtualPathKey(
  virtual: Record<string, string>,
  specifier: string,
): string | undefined {
  const url = _virtualKeyURL(_stripQuery(specifier));
  if (!url) {
    return undefined;
  }
  // Later keys win, as in the hook's URL map.
  let match: string | undefined;
  for (const key of Object.keys(virtual)) {
    if (_virtualKeyURL(key) === url) {
      match = key;
    }
  }
  return match;
}

const _warnedPathCollisions = new Set<string>();

/**
 * Warn (once per pair and process) about path keys naming the same file, like
 * `/app/x.mjs` and `file:///app/x.mjs`: only one of them can be served. Run on
 * the host, which sees the keys first for every runner. Never throws.
 */
export function warnVirtualPathCollisions(keys: Iterable<string>): void {
  try {
    const urlKeys = new Map<string, string>();
    for (const key of keys) {
      const url = _virtualKeyURL(key);
      if (!url) {
        continue;
      }
      const other = urlKeys.get(url);
      if (other !== undefined && !_warnedPathCollisions.has(`${other}\0${key}`)) {
        _warnedPathCollisions.add(`${other}\0${key}`);
        console.warn(
          `[env-runner] virtual modules "${other}" and "${key}" name the same file; keep only one of them (which one is served depends on the runtime).`,
        );
      }
      urlKeys.set(url, key);
    }
  } catch {
    // Best effort: a warning must never break startup.
  }
}

/**
 * `file:` URL (no query or hash) of a path key, else `undefined`. Disk files are
 * tracked under it in {@link VirtualHooksOptions}.
 */
export const virtualKeyURL: (key: string) => string | undefined = _virtualKeyURL;

// `file:` URL of a path key (absolute path or `file:` URL), else `undefined`:
// `#name`, bare and relative keys only match verbatim.
function _virtualKeyURL(key: string): string | undefined {
  if (key.startsWith("file:")) {
    try {
      return _bareURL(new URL(key).href);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(key) ? pathToFileURL(key).href : undefined;
}

// Readable `virtual:` URL of a non-path specifier (`virtual:#config?raw`). Only
// what a URL parser would change or misread is percent-encoded: `%`, controls,
// space, `"`, `<`, `>`, backtick, non-ASCII. So `new URL(url).href === url`,
// and the first `?` ends the key (keys can't contain one). A `#name` key lands
// in the fragment, which Node and Deno keep in module identities (like the
// HTML module map).
function _virtualURL(specifier: string): string {
  return VIRTUAL_SCHEME + specifier.replace(/[\0-\x20"%<>`\x7F-\u{10FFFF}]/gu, encodeURIComponent);
}

// Key of a `virtual:` URL, `undefined` for a malformed escape (not ours).
function _virtualURLKey(url: string): string | undefined {
  try {
    return decodeURIComponent(_stripQuery(url.slice(VIRTUAL_SCHEME.length)));
  } catch {
    return undefined;
  }
}

// ESM, or unknown: Deno's `nextLoad()` reports no format.
function _isModuleFormat(format: string | null | undefined): boolean {
  return format == null || format === "module" || format === "module-typescript";
}

function _stripQuery(specifier: string): string {
  const qIndex = specifier.indexOf("?");
  return qIndex === -1 ? specifier : specifier.slice(0, qIndex);
}

// URL without its query and hash (literal `?`/`#` in file paths are encoded).
function _bareURL(url: string): string {
  const index = url.search(/[?#]/);
  return index === -1 ? url : url.slice(0, index);
}

// A `virtual:` URL keeps its key's `#` literal (see `_virtualURL()`), so the
// query always goes last there.
function _appendQuery(url: string, param: string): string {
  const hashIndex = url.startsWith(VIRTUAL_SCHEME) ? -1 : url.indexOf("#");
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  return base + (base.includes("?") ? "&" : "?") + param + hash;
}

// Relative (`./`, `../`), root-relative (`/`) and `file:` specifiers resolve
// like Node (`new URL()` against the parent), other absolute paths (`C:\`) via
// `pathToFileURL`. `undefined` for bare specifiers or a non-hierarchical parent.
function _resolvePathSpecifier(
  specifier: string,
  parentURL: string | undefined,
): string | undefined {
  try {
    if (/^\.{0,2}\//.test(specifier) || specifier.startsWith("file:")) {
      return new URL(specifier, parentURL).href;
    }
    if (isAbsolute(specifier)) {
      const path = _stripQuery(specifier);
      return pathToFileURL(path).href + specifier.slice(path.length);
    }
  } catch {
    // e.g. relative to a `data:` parent: left to default resolution.
  }
  return undefined;
}

// Working directory as a trailing-slash file URL, usable directly as a module
// resolution base (node_modules walk starts at the directory itself).
function _defaultBaseURL(): string {
  return pathToFileURL(process.cwd() + "/").href;
}
