// Filter matching shared by the host (full `transform` filters) and workers
// (the prefilter deciding which modules to send). The host compiles filters
// to this serializable form (`id` globs as RegExps).

/** Module type of code (`js` once a plugin compiled it). */
export type PluginModuleType = "js" | "jsx" | "ts" | "tsx" | (string & {});

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
 * Worker side: whether some plugin may transform a module, from the plugins'
 * serialized filters (the host checks the full filters). `id` is
 * `/`-separated.
 */
export function createPrefilter(
  filters: SerializedPrefilter[],
): (id: string, moduleType: PluginModuleType) => boolean {
  const compiled = filters.map(
    (filter): ((id: string, moduleType: PluginModuleType) => boolean) => {
      if (filter.expr) {
        const test = compileFilterExpressions(filter.expr);
        return (id, moduleType) => test(id, moduleType) !== false;
      }
      const idFilter =
        filter.id &&
        compileFilter(
          filter.id.include.map(deserializePattern),
          filter.id.exclude.map(deserializePattern),
          (pattern, value) => pattern.test(value),
        );
      return (id, moduleType) =>
        (!filter.moduleTypes || filter.moduleTypes.includes(moduleType)) &&
        (!idFilter || idFilter.test(id));
    },
  );
  return (id, moduleType) => compiled.some((test) => test(id, moduleType));
}
