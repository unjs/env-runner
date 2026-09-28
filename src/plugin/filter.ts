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
   * A `load` filter: it can't name module types, so a module its `id`
   * include (or include expression) names counts as `"typed"`
   * ({@link PrefilterMatch}).
   */
  load?: true;
}

/**
 * A module under `/node_modules/` (linked workspace packages resolve outside
 * it). Plugins only get those when an `id` include naming `node_modules`
 * matches, or a `resolveId` hook returned the path. Takes a `/`-separated
 * id (its query is ignored).
 */
export function isNodeModulesId(id: string): boolean {
  return stripQuery(id).includes("/node_modules/");
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

/** An id as filters see it: its path `/`-separated, with its query. */
export function normalizeFilterId(id: string): string {
  const path = stripQuery(id);
  return path.replaceAll("\\", "/") + id.slice(path.length);
}

export function stripQuery(id: string): string {
  const qIndex = id.indexOf("?");
  return qIndex === -1 ? id : id.slice(0, qIndex);
}

/** The query of an id (`?a&b=1`, without a `#` fragment), or `""`. */
export function queryOf(id: string): string {
  const qIndex = id.indexOf("?");
  if (qIndex === -1) {
    return "";
  }
  const hashIndex = id.indexOf("#", qIndex);
  return hashIndex === -1 ? id.slice(qIndex) : id.slice(qIndex, hashIndex);
}

// Query params env-runner adds itself: reload cache-busting, Bun's routing
// markers (virtual and plugin-loaded modules) and miniflare's CommonJS shims.
const INTERNAL_PARAMS: ReadonlySet<string> = new Set([
  "__envRunnerReload",
  "__env_runner_virtual",
  "__env_runner_disk",
  "__env_runner_plugin",
  "__cjs",
]);

/**
 * An id without the query params env-runner adds itself (reload
 * cache-busting, Bun markers, miniflare's CommonJS shims), and without a
 * virtual module version (`v=<version>`, always the last param) when
 * `version` is given. Other params are kept as written, in order.
 */
export function stripInternalQuery(id: string, version?: number): string {
  const qIndex = id.indexOf("?");
  if (qIndex === -1) {
    return id;
  }
  const params = id.slice(qIndex + 1).split("&");
  if (version && params.at(-1) === `v=${version}`) {
    params.pop();
  }
  const kept = params.filter((param) => !_isInternalParam(param));
  return id.slice(0, qIndex) + (kept.length > 0 ? `?${kept.join("&")}` : "");
}

/**
 * Append the params {@link stripInternalQuery} removes from `from` (a
 * reload's cache-busting) to `id`, a URL or path a plugin resolved it to.
 */
export function restoreInternalQuery(id: string, from: string): string {
  const internal = queryOf(from).slice(1).split("&").filter(_isInternalParam);
  if (internal.length === 0) {
    return id;
  }
  return id + (id.includes("?") ? "&" : "?") + internal.join("&");
}

function _isInternalParam(param: string): boolean {
  return INTERNAL_PARAMS.has(param.split("=", 1)[0]!);
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
      // Parsed with `URLSearchParams`: a boolean tests whether the key is
      // present, a string equals its (first) value, a RegExp tests that value
      // (`""` when absent).
      const { key, pattern } = node;
      const regexp = typeof pattern === "object" ? deserializePattern(pattern) : undefined;
      return (id) => {
        const params = new URLSearchParams(queryOf(id));
        if (typeof pattern === "boolean") {
          return params.has(key) === pattern;
        }
        const value = params.get(key);
        return regexp ? regexp.test(value ?? "") : value === pattern;
      };
    }
  }
}

/**
 * How a filter matches a module without its code: `false`, `true`, `"named"`
 * when an `id` include matches it, or `"typed"` when its `moduleType` filter
 * lists the module's type. For filter expressions, the include that matches
 * names it with a matching `id` (or a present `query` param) and types it
 * with a matching `moduleType`.
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
 * `code` (host only) makes the level of filter expressions exact.
 */
export type PrefilterTest = (
  id: string,
  moduleType: PluginModuleType,
  resolved?: boolean,
  code?: string,
) => PrefilterMatch;

export function compilePrefilter(filter: SerializedPrefilter): PrefilterTest {
  const namedLevel = filter.load ? "typed" : "named";
  // `id` includes naming `node_modules`, the only ones reaching it.
  const nodeModules = nodeModulesIncludes(filter).map(deserializePattern);
  const excluded = (id: string, resolved?: boolean) =>
    !resolved && isNodeModulesId(id) && !nodeModules.some((pattern) => pattern.test(id));
  if (filter.expr) {
    const level = _compileExpressionsLevel(filter.expr);
    const levels = [false, true, namedLevel, "typed"] as const;
    return (id, moduleType, resolved, code) =>
      !excluded(id, resolved) && levels[level(id, moduleType, code)];
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

// How filter expressions may match a module: 0 not at all, 1 without naming
// it (`code`, `not`, `query(key, false)`), 2 named by an `id` or a present
// `query` param, 3 typed by a `moduleType`. Without the code, the highest
// level any possible outcome has (the host then checks with the code).
type ExpressionLevel = 0 | 1 | 2 | 3;
type ExpressionLevelTest = (
  id: string,
  moduleType: PluginModuleType,
  code?: string,
) => ExpressionLevel;

// The deciding expression, as in `compileFilterExpressions()`: the first one
// that matches, or any unknown one before it.
function _compileExpressionsLevel(expressions: SerializedFilterExpression[]): ExpressionLevelTest {
  const compiled = expressions.map(({ kind, expr }) => ({
    include: kind === "include",
    test: _compileNode(expr),
    level: _compileNodeLevel(expr),
  }));
  const hasInclude = compiled.some((expr) => expr.include);
  return (id, moduleType, code) => {
    let level: ExpressionLevel = 0;
    for (const expr of compiled) {
      const result = expr.test(id, moduleType, code);
      if (result === false) {
        continue;
      }
      if (expr.include) {
        level = Math.max(level, expr.level(id, moduleType, code)) as ExpressionLevel;
      }
      if (result) {
        return level;
      }
    }
    return hasInclude ? level : (Math.max(level, 1) as ExpressionLevel);
  };
}

function _compileNodeLevel(node: SerializedFilterNode): ExpressionLevelTest {
  const test = _compileNode(node);
  const matched = (level: ExpressionLevel): ExpressionLevelTest => {
    return (id, moduleType, code) => (test(id, moduleType, code) === false ? 0 : level);
  };
  switch (node.kind) {
    case "and":
    case "or": {
      // `and`: every argument holds, `or`: any that may hold.
      const args = node.args.map(_compileNodeLevel);
      return (id, moduleType, code) =>
        test(id, moduleType, code) === false
          ? 0
          : (Math.max(...args.map((arg) => arg(id, moduleType, code))) as ExpressionLevel);
    }
    case "id": {
      return matched(2);
    }
    case "moduleType": {
      return matched(3);
    }
    case "query": {
      const { key } = node;
      return (id, moduleType, code) =>
        test(id, moduleType, code) === false
          ? 0
          : new URLSearchParams(queryOf(id)).has(key)
            ? 2
            : 1;
    }
    default: {
      return matched(1);
    }
  }
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
 * {@link normalizeFilterId normalized}. Modules of other than {@link SCRIPT_MODULE_TYPES} only
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
