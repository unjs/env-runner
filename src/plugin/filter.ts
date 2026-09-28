// Filter matching shared by the host (full `transform` filters) and workers
// (the prefilter deciding which modules to send). The host compiles filters
// to this serializable form (`id` globs as RegExps).

/**
 * Module type of code: `js`, `jsx`, `ts`, `tsx` and `json` from the
 * extension, other extensions as themselves (`vue` for `.vue`), `js` without
 * an extension.
 */
export type PluginModuleType = "js" | "jsx" | "ts" | "tsx" | "json" | (string & {});

/** Module types every plugin sees; others only reach plugins naming them. */
export const SCRIPT_MODULE_TYPES: readonly string[] = ["js", "jsx", "ts", "tsx"];

/** A RegExp as sent to workers (`glob`: compiled from an `id` glob). */
export interface SerializedPattern {
  source: string;
  flags: string;
  glob?: true;
}

/** A filter expression as sent to workers. */
export type SerializedFilterNode =
  | { kind: "and" | "or"; args: SerializedFilterNode[] }
  | { kind: "not"; expr: SerializedFilterNode }
  | { kind: "id"; pattern: SerializedPattern }
  | { kind: "code"; pattern: string | SerializedPattern }
  | { kind: "moduleType"; pattern: string }
  | { kind: "query"; key: string; pattern: string | boolean | SerializedPattern };

export interface SerializedFilterExpression {
  kind: "include" | "exclude";
  expr: SerializedFilterNode;
}

/**
 * A plugin's filter as workers check it: its `id`/`moduleType` filters, or
 * its filter expressions (`code` is unknown there).
 */
export interface SerializedPrefilter {
  id?: { include: SerializedPattern[]; exclude: SerializedPattern[] };
  moduleTypes?: PluginModuleType[];
  expr?: SerializedFilterExpression[];
  /**
   * A `load` filter: it can't name module types, so a matching `id` include
   * (or include expression) counts as `"typed"` ({@link PrefilterMatch}).
   */
  load?: true;
}

/**
 * A module under `/node_modules/` (linked workspace packages resolve outside
 * it). Plugins only get those when an `id` include naming `node_modules`
 * matches, or a `resolveId` hook returned the path. Takes a `/`-separated
 * path.
 */
export function isNodeModulesId(id: string): boolean {
  return id.includes("/node_modules/");
}

/** Initial module type of a module, from its extension. */
export function moduleTypeOf(path: string): PluginModuleType {
  const ext = /\.([^./\\?]+)$/.exec(stripQuery(path))?.[1]?.toLowerCase();
  if (!ext || /^[cm]?js$/.test(ext)) {
    return "js";
  }
  if (/^[cm]?ts$/.test(ext)) {
    return "ts";
  }
  return ext;
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

export function deserializePattern(pattern: SerializedPattern): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/**
 * Whether filter expressions match: `undefined` when that depends on the
 * code and `code` isn't given. The first include or exclude that matches
 * decides; without any, the module matches unless there are includes.
 */
export type FilterExpressionTest = (
  id: string,
  moduleType: PluginModuleType,
  code?: string,
) => boolean | undefined;

export function compileFilterExpressions(
  expressions: SerializedFilterExpression[],
): FilterExpressionTest {
  const compiled = expressions.map(({ kind, expr }) => ({
    include: kind === "include",
    test: _compileNode(expr),
  }));
  const hasInclude = compiled.some((expr) => expr.include);
  return (id, moduleType, code) => {
    // An unknown result before the deciding one could have decided instead.
    let unknown = false;
    for (const expr of compiled) {
      const result = expr.test(id, moduleType, code);
      if (result === undefined) {
        unknown = true;
      } else if (result) {
        return unknown ? undefined : expr.include;
      }
    }
    return unknown ? undefined : !hasInclude;
  };
}

// Three-valued: `undefined` is unknown (`code` without code).
function _compileNode(node: SerializedFilterNode): FilterExpressionTest {
  switch (node.kind) {
    case "and":
    case "or": {
      const args = node.args.map(_compileNode);
      const decisive = node.kind === "or";
      return (id, moduleType, code) => {
        let result: boolean | undefined = !decisive;
        for (const arg of args) {
          const value = arg(id, moduleType, code);
          if (value === decisive) {
            return decisive;
          }
          if (value === undefined) {
            result = undefined;
          }
        }
        return result;
      };
    }
    case "not": {
      const expr = _compileNode(node.expr);
      return (id, moduleType, code) => {
        const value = expr(id, moduleType, code);
        return value === undefined ? undefined : !value;
      };
    }
    case "id": {
      const pattern = deserializePattern(node.pattern);
      return (id) => pattern.test(id);
    }
    case "moduleType": {
      return (_id, moduleType) => moduleType === node.pattern;
    }
    case "code": {
      const pattern =
        typeof node.pattern === "string" ? node.pattern : deserializePattern(node.pattern);
      return (_id, _moduleType, code) =>
        code === undefined
          ? undefined
          : typeof pattern === "string"
            ? code.includes(pattern)
            : pattern.test(code);
    }
    case "query": {
      // Ids are matched without their query: only "absent" matches.
      const absent = node.pattern === false;
      return () => absent;
    }
  }
}

/**
 * How a filter matches a module without its code: `false`, `true`, `"named"`
 * when an `id` include (or, for filter expressions, an include) matches it,
 * or `"typed"` when its `moduleType` filter lists the module's type.
 */
export type PrefilterMatch = boolean | "named" | "typed";

/**
 * The match a module of this type needs ({@link PrefilterMatch}): any for
 * {@link SCRIPT_MODULE_TYPES}, `"typed"` for types the runtime loads itself
 * (`json`, `node`, `wasm`), `"named"` for others.
 */
export function requiredMatch(moduleType: PluginModuleType): "named" | "typed" | undefined {
  if (SCRIPT_MODULE_TYPES.includes(moduleType)) {
    return undefined;
  }
  return moduleType === "json" || moduleType === "node" || moduleType === "wasm"
    ? "typed"
    : "named";
}

/**
 * `resolved`: a path a `resolveId` hook returned, which may be under
 * `/node_modules/` without a filter naming it ({@link isNodeModulesId}).
 */
export type PrefilterTest = (
  id: string,
  moduleType: PluginModuleType,
  resolved?: boolean,
) => PrefilterMatch;

export function compilePrefilter(filter: SerializedPrefilter): PrefilterTest {
  const namedLevel = filter.load ? "typed" : "named";
  // `id` includes naming `node_modules`, the only ones reaching it.
  const nodeModules = nodeModulesIncludes(filter).map(deserializePattern);
  const excluded = (id: string, resolved?: boolean) =>
    !resolved && isNodeModulesId(id) && !nodeModules.some((pattern) => pattern.test(id));
  if (filter.expr) {
    const test = compileFilterExpressions(filter.expr);
    const named = filter.expr.some((expr) => expr.kind === "include") && namedLevel;
    return (id, moduleType, resolved) =>
      !excluded(id, resolved) && test(id, moduleType) !== false && (named || true);
  }
  const idFilter =
    filter.id &&
    compileFilter(
      filter.id.include.map(deserializePattern),
      filter.id.exclude.map(deserializePattern),
      (pattern, value) => pattern.test(value),
    );
  const named = Boolean(idFilter?.include.length);
  return (id, moduleType, resolved) =>
    !excluded(id, resolved) &&
    (!filter.moduleTypes || filter.moduleTypes.includes(moduleType)) &&
    (!idFilter || idFilter.test(id)) &&
    (filter.moduleTypes ? "typed" : named ? namedLevel : true);
}

/** Whether a {@link PrefilterMatch} is at least `required`. */
export function satisfiesMatch(
  match: PrefilterMatch,
  required: "named" | "typed" | undefined,
): boolean {
  if (match === false) {
    return false;
  }
  return !required || match === "typed" || (required === "named" && match === "named");
}

/**
 * Worker side: whether some plugin may load or transform a module, from the
 * plugins' serialized filters (the host checks the full filters). `id` is
 * `/`-separated. Modules of other than {@link SCRIPT_MODULE_TYPES} only
 * count when a filter names them ({@link requiredMatch}).
 */
export function createPrefilter(
  filters: SerializedPrefilter[],
): (id: string, moduleType: PluginModuleType, resolved?: boolean) => boolean {
  const compiled = filters.map(compilePrefilter);
  return (id, moduleType, resolved) => {
    const required = requiredMatch(moduleType);
    return compiled.some((test) => satisfiesMatch(test(id, moduleType, resolved), required));
  };
}

/**
 * A filter's `id` include patterns naming `node_modules` (in include
 * expressions: any `id` pattern that does).
 */
export function nodeModulesIncludes(filter: SerializedPrefilter): SerializedPattern[] {
  const names = (pattern: SerializedPattern) => pattern.source.includes("node_modules");
  if (!filter.expr) {
    return filter.id?.include.filter(names) ?? [];
  }
  const patterns: SerializedPattern[] = [];
  const walk = (node: SerializedFilterNode) => {
    if (node.kind === "id" && names(node.pattern)) {
      patterns.push(node.pattern);
    } else if (node.kind === "and" || node.kind === "or") {
      node.args.forEach(walk);
    }
  };
  for (const { kind, expr } of filter.expr) {
    if (kind === "include") {
      walk(expr);
    }
  }
  return patterns;
}
