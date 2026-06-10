import type { ResolveHookSync, LoadHookSync } from "node:module";

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

export function createVirtualHooks(virtual: Record<string, string>): {
  resolve: ResolveHookSync;
  load: LoadHookSync;
} {
  const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
    // Strip a cache-busting `?query` suffix (used by reload) before matching, but
    // keep it in the URL so each reload yields a distinct module identity.
    if (Object.hasOwn(virtual, _stripQuery(specifier))) {
      return {
        url: VIRTUAL_SCHEME + encodeURIComponent(specifier),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  };

  const load: LoadHookSync = (url, context, nextLoad) => {
    if (url.startsWith(VIRTUAL_SCHEME)) {
      const key = _stripQuery(decodeURIComponent(url.slice(VIRTUAL_SCHEME.length)));
      if (Object.hasOwn(virtual, key)) {
        return {
          format: virtualModuleFormat(key),
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

function _stripQuery(specifier: string): string {
  const qIndex = specifier.indexOf("?");
  return qIndex === -1 ? specifier : specifier.slice(0, qIndex);
}
