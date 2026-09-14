import type { ResolveHookSync, LoadHookSync } from "node:module";
import { pathToFileURL } from "node:url";

/** Factories run once on the host, before the worker spawns. */
export type VirtualModuleSource = string | (() => string | Promise<string>);

/** Virtual modules as a `specifier => source` map. */
export type VirtualModules = Record<string, VirtualModuleSource>;

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

/**
 * `module.registerHooks()` hooks serving virtual modules from resolved string
 * sources (the sync load hook can't await a factory).
 */
const VIRTUAL_SCHEME = "virtual:";

export function createVirtualHooks(
  virtual: Record<string, string>,
  versions?: ReadonlyMap<string, number>,
  // Resolution base for a virtual module's own non-virtual imports.
  parentURL: string = _defaultParentURL(),
  // For backends that pre-transform sources to JS (Deno >= 2.9 honors the
  // format and would re-parse them as JSON/TS).
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
      // Version is appended outside the encoded specifier for a fresh identity.
      const version = versions?.get(key);
      return {
        url: VIRTUAL_SCHEME + encodeURIComponent(specifier) + (version ? `?v=${version}` : ""),
        shortCircuit: true,
      };
    }
    // `virtual:` is opaque, so default resolution throws building a base from it
    // (`getPackageScopeConfig`); re-base on a real directory.
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
  return stripTypeScriptTypes(source);
}

/**
 * Include transitive virtual importers, else a cached importer still links the
 * old module. Over-matching the quoted scan only forces a re-evaluation.
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
