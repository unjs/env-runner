import * as nodePath from "node:path";

// Filter matching shared by the host (full `transform` filters) and workers
// (the `id`/`moduleType` prefilter deciding which modules to send).

/** Module type of code (`js` once a plugin compiled it). */
export type PluginModuleType = "js" | "jsx" | "ts" | "tsx" | (string & {});

/** A filter pattern as sent to workers: a glob, or a RegExp's parts. */
export type SerializedPattern = string | { source: string; flags: string };

/** The part of a plugin's filter workers can check before sending a module. */
export interface SerializedPrefilter {
  id?: { include: SerializedPattern[]; exclude: SerializedPattern[] };
  moduleTypes?: PluginModuleType[];
}

/** File extensions of modules plugins can transform. */
export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];

/**
 * A disk module plugins may transform: a script extension, and not under
 * `/node_modules/` (linked workspace packages resolve outside it). Takes a
 * `/`-separated path without query.
 */
export function isTransformCandidate(path: string): boolean {
  return !path.includes("/node_modules/") && SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Initial module type of a file, from its extension. */
export function moduleTypeOf(path: string): PluginModuleType {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (ext === "tsx" || ext === "jsx") {
    return ext;
  }
  return /^[cm]?ts$/.test(ext) ? "ts" : "js";
}

/** `/`-separated path without query, as filters see it. */
export function normalizeFilterId(id: string): string {
  return stripQuery(id).replaceAll("\\", "/");
}

export function stripQuery(id: string): string {
  const qIndex = id.indexOf("?");
  return qIndex === -1 ? id : id.slice(0, qIndex);
}

/** Include and exclude patterns (exclude wins; no includes match everything). */
export interface CompiledFilter<T> {
  include: T[];
  exclude: T[];
  test: (value: string) => boolean;
}

export function compileFilter<T>(
  include: T[],
  exclude: T[],
  match: (pattern: T, value: string) => boolean,
): CompiledFilter<T> {
  return {
    include,
    exclude,
    test: (value) =>
      !exclude.some((pattern) => match(pattern, value)) &&
      (include.length === 0 || include.some((pattern) => match(pattern, value))),
  };
}

/**
 * Test an `id` pattern: globs with `path.matchesGlob` (relative ones resolve
 * from cwd), RegExps as is. The id is `/`-separated.
 */
export function matchId(pattern: string | RegExp, id: string): boolean {
  if (typeof pattern !== "string") {
    return testRegExp(pattern, id);
  }
  // Namespace access: a named import fails to link before Node.js 22.5.
  if (typeof nodePath.matchesGlob !== "function") {
    throw new TypeError(
      "[env-runner] glob `id` filters need `path.matchesGlob` (Node.js >= 22.5); use a RegExp instead.",
    );
  }
  return nodePath.matchesGlob(id, resolveGlob(pattern));
}

/** Relative globs resolve from cwd (`**` patterns are left as they are). */
export function resolveGlob(pattern: string): string {
  return nodePath.isAbsolute(pattern) || pattern.startsWith("*")
    ? pattern
    : nodePath.join(process.cwd(), pattern).replaceAll("\\", "/");
}

// `g`/`y` RegExps are stateful through `lastIndex`.
export function testRegExp(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * Worker side: whether some plugin may transform a module, from the plugins'
 * serialized `id`/`moduleType` filters (the host checks the full filters).
 * `id` is `/`-separated.
 */
export function createPrefilter(
  filters: SerializedPrefilter[],
): (id: string, moduleType: PluginModuleType) => boolean {
  const compiled = filters.map((filter) => ({
    moduleTypes: filter.moduleTypes,
    id:
      filter.id &&
      compileFilter(
        filter.id.include.map(deserializePattern),
        filter.id.exclude.map(deserializePattern),
        matchId,
      ),
  }));
  return (id, moduleType) =>
    compiled.some(
      (filter) =>
        (!filter.moduleTypes || filter.moduleTypes.includes(moduleType)) &&
        (!filter.id || filter.id.test(id)),
    );
}

export function serializePattern(pattern: string | RegExp): SerializedPattern {
  return typeof pattern === "string"
    ? resolveGlob(pattern)
    : { source: pattern.source, flags: pattern.flags };
}

export function deserializePattern(pattern: SerializedPattern): string | RegExp {
  return typeof pattern === "string" ? pattern : new RegExp(pattern.source, pattern.flags);
}
