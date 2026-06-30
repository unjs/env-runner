import type { ResolveHookSync, LoadHookSync } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Source for a virtual module: either a literal ES module string or a factory
 * that returns one (sync or async).
 *
 * Factories are evaluated **once on the host side** before the worker is spawned
 * (functions can't cross the `workerData`/`JSON` boundary, and Node's synchronous
 * load hook can't await), so the worker always receives plain strings. See
 * {@link resolveVirtualModules}.
 */
export type VirtualModuleSource = string | (() => string | Promise<string>);

/** Virtual modules as a `specifier => source` map. */
export type VirtualModules = Record<string, VirtualModuleSource>;

/**
 * Resolve every {@link VirtualModuleSource} in a {@link VirtualModules} map to a
 * plain string, invoking and awaiting factory functions. Returns a map safe to
 * pass across the worker boundary and to {@link createVirtualHooks}.
 */
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

/**
 * Build Node.js ESM customization hooks that serve virtual modules from an
 * in-memory `specifier => source` map.
 *
 * Any import whose specifier matches a map key (e.g. `#virtual-import`) is
 * resolved to a `virtual:` URL and loaded from the stored source,
 * short-circuiting default resolution. Intended for use with
 * {@link https://nodejs.org/api/module.html#moduleregisterhooksoptions | module.registerHooks()},
 * which runs the hooks synchronously in the current thread.
 *
 * The load format is derived from the specifier extension (see
 * {@link virtualModuleFormat}): `.ts`/`.mts` sources are served as
 * `module-typescript` (Node's native type stripping) and `.json` as JSON
 * modules (import them `with { type: "json" }`). Deno ignores the `format`
 * returned by custom load hooks, so on Deno the map must be pre-transformed to
 * plain ESM sources first — see `registerVirtualModules()`.
 *
 * Sources must already be resolved to strings (see {@link resolveVirtualModules})
 * because the load hook runs synchronously and cannot await a factory.
 */
const VIRTUAL_SCHEME = "virtual:";

export function createVirtualHooks(
  virtual: Record<string, string>,
  versions?: ReadonlyMap<string, number>,
  // Real directory URL used as the resolution base for a virtual module's own
  // (non-virtual) imports — see the re-base in `resolve` below. Defaults to the
  // working directory so bare/relative specifiers resolve against the project.
  parentURL: string = _defaultParentURL(),
  // Always report the `module` (plain ESM) load format, ignoring the specifier
  // extension. Used by backends that pre-transform every source to plain JS
  // before registration (Deno — see `registerVirtualModules()`): there a `.json`
  // source is already a JS wrapper and a `.ts` source already type-stripped, so
  // honoring the extension-derived `json`/`module-typescript` format makes the
  // runtime re-parse JS as JSON/TS and fail (Deno >= 2.9 honors the format).
  forcePlainModule = false,
): {
  resolve: ResolveHookSync;
  load: LoadHookSync;
} {
  const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
    // Strip a cache-busting `?query` suffix (used by reload) before matching, but
    // keep it in the URL so each reload yields a distinct module identity.
    const key = _stripQuery(specifier);
    if (Object.hasOwn(virtual, key)) {
      // The invalidation version (see `invalidateVirtualModule()`) is appended
      // outside the encoded specifier, so the same plain import resolves to a
      // fresh module identity after each invalidation.
      const version = versions?.get(key);
      return {
        url: VIRTUAL_SCHEME + encodeURIComponent(specifier) + (version ? `?v=${version}` : ""),
        shortCircuit: true,
      };
    }
    // A bare/relative import inside a virtual module arrives with a `virtual:`
    // parentURL. That scheme is opaque (non-hierarchical), so default resolution
    // throws when it builds a base from it (`new URL("./package.json",
    // "virtual:...")` in `getPackageScopeConfig`). Re-base such imports on a real
    // directory URL so they resolve against the project instead of crashing.
    if (context.parentURL?.startsWith(VIRTUAL_SCHEME)) {
      return nextResolve(specifier, { ...context, parentURL });
    }
    return nextResolve(specifier, context);
  };

  const load: LoadHookSync = (url, context, nextLoad) => {
    if (url.startsWith(VIRTUAL_SCHEME)) {
      const key = _stripQuery(decodeURIComponent(url.slice(VIRTUAL_SCHEME.length)));
      if (Object.hasOwn(virtual, key)) {
        return {
          format: forcePlainModule ? "module" : virtualModuleFormat(key),
          source: virtual[key],
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  };

  return { resolve, load };
}

/**
 * Module format for a virtual specifier, derived from its extension: `.json`
 * loads as a JSON module, `.ts`/`.mts` as type-stripped TypeScript (served
 * natively by Node.js >= 22.18 / 23.6; other backends transform up front),
 * anything else as a plain ES module.
 */
export function virtualModuleFormat(specifier: string): "module" | "module-typescript" | "json" {
  if (specifier.endsWith(".json")) {
    return "json";
  }
  if (specifier.endsWith(".ts") || specifier.endsWith(".mts")) {
    return "module-typescript";
  }
  return "module";
}

/**
 * Strip types from a virtual `.ts`/`.mts` source for a backend that can't
 * parse TypeScript itself (Deno load hooks, workerd). Throws a clear
 * `TypeError` when `module.stripTypeScriptTypes` is unavailable, with a
 * backend-specific `requirement` (why it's needed) and `remedy` (what to
 * upgrade) woven into the message.
 */
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
  return stripTypeScriptTypes(source);
}

/**
 * Expand an invalidated specifier to the set of virtual modules that must get
 * a fresh identity: the specifier itself plus every virtual module that
 * (transitively) imports it. Without this, a reloaded entry would resolve an
 * intermediate importer to its cached instance, which still links the old
 * module.
 *
 * Importers are detected with a quoted-occurrence scan of the virtual sources
 * (the only modules whose identity invalidation can refresh — disk modules
 * follow the entry-reload semantics). Over-matching is harmless: a bumped
 * version only forces a re-evaluation of a module we already own the source of.
 */
export function expandVirtualInvalidation(
  virtual: Record<string, string>,
  specifier: string,
): string[] {
  const invalidated = [specifier];
  const seen = new Set(invalidated);
  for (const target of invalidated) {
    const refs = [`"${target}"`, `'${target}'`, "`" + target + "`"];
    for (const [key, source] of Object.entries(virtual)) {
      if (!seen.has(key) && refs.some((ref) => source.includes(ref))) {
        seen.add(key);
        invalidated.push(key);
      }
    }
  }
  return invalidated;
}

function _stripQuery(specifier: string): string {
  const qIndex = specifier.indexOf("?");
  return qIndex === -1 ? specifier : specifier.slice(0, qIndex);
}

// Working directory as a trailing-slash file URL, usable directly as a module
// resolution base (node_modules walk starts at the directory itself).
function _defaultParentURL(): string {
  return pathToFileURL(process.cwd() + "/").href;
}
