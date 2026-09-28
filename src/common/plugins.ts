import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { virtualModuleFormat } from "../virtual-loader.ts";
import type { ResolvedVirtualModule } from "../virtual-loader.ts";
import {
  compileFilter,
  compileFilterExpressions,
  deserializePattern,
  isTransformCandidate,
  moduleTypeOf,
  normalizeFilterId,
  stripQuery,
} from "./plugin-filter.ts";
import type {
  PluginModuleType,
  SerializedFilterExpression,
  SerializedFilterNode,
  SerializedPattern,
  SerializedPrefilter,
} from "./plugin-filter.ts";
import { globToRegExp, resolveGlob } from "./plugin-glob.ts";

export type { PluginModuleType } from "./plugin-filter.ts";

type MaybeArray<T> = T | T[];

/** Include values, or `{ include, exclude }` (exclude wins). */
export type PluginStringFilter =
  | MaybeArray<string | RegExp>
  | { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };

/**
 * `transform` hook filter (all given properties must match; empty ones are
 * ignored). Ids are matched `/`-separated and without their query string.
 * - `id`: RegExps are tested, strings are globs: `*` (within a path segment),
 *   `?`, `**` (any number of segments), `[abc]`/`[!abc]`, `{a,b}` and `\`
 *   escapes, case-sensitive; `*` and `**` also match dot files and
 *   directories. Globs not starting with `**` and not absolute resolve from
 *   the working directory when the runner is created.
 * - `code`: strings are substrings, RegExps are tested.
 * - `moduleType`: see {@link PluginModuleType}.
 *
 * `id` and `moduleType` are also checked in the worker, before a module is
 * sent to the runner: give plugins both where possible, so other modules
 * load without a round trip.
 */
export interface PluginTransformFilter {
  id?: PluginStringFilter;
  code?: PluginStringFilter;
  moduleType?: PluginModuleType[] | { include?: PluginModuleType[] };
}

/**
 * A filter expression, matched like the {@link PluginTransformFilter}
 * properties. `query` sees no query (only `pattern: false` matches), and
 * `importerId` is rejected (there is no importer here).
 */
export type PluginFilterExpression =
  | { kind: "and" | "or"; args: PluginFilterExpression[] }
  | { kind: "not"; expr: PluginFilterExpression }
  | { kind: "id" | "importerId"; pattern: string | RegExp }
  | { kind: "code"; pattern: string | RegExp }
  | { kind: "moduleType"; pattern: PluginModuleType }
  | { kind: "query"; key: string; pattern: string | RegExp | boolean };

/**
 * A filter as a list of include and exclude expressions: the first one that
 * matches decides (an include matches, an exclude doesn't); if none does, the
 * module matches only when there are no includes. The worker's prefilter
 * sends a module unless the expressions can't match whatever its code.
 */
export interface PluginTopLevelFilterExpression {
  kind: "include" | "exclude";
  expr: PluginFilterExpression;
}

/** Passed to every handler. */
export interface PluginTransformMeta {
  /** Language of `code` (updated by results returning a `moduleType`). */
  moduleType: PluginModuleType;
}

/** A message for {@link PluginContext}: a string, or a log object. */
export type PluginLog = string | { message: string };

/** An offset in the code, or a 1-based line and 0-based column. */
export type PluginLogPosition = number | { line: number; column: number };

/**
 * `this` in handlers. Messages are prefixed with the plugin name and module
 * id, and a position given is appended to the id (`id:line:column`).
 */
export interface PluginContext {
  /** Log a warning (on the host). */
  warn(log: PluginLog, pos?: PluginLogPosition): void;
  /** Log a message (on the host). */
  info(log: PluginLog, pos?: PluginLogPosition): void;
  /** Ignored (debug messages aren't shown). */
  debug(log: PluginLog, pos?: PluginLogPosition): void;
  /** Throw an error (an `Error` or log object given is kept as its `cause`). */
  error(log: PluginLog, pos?: PluginLogPosition): never;
}

/** Runs on the host and may be async. Return nullish to keep the code. */
export type PluginTransformHandler = (
  this: PluginContext,
  code: string,
  id: string,
  meta: PluginTransformMeta,
) => PluginTransformResult | Promise<PluginTransformResult>;

/**
 * New code, or `{ code, map, moduleType }`: a `moduleType` tells later
 * handlers the new language (e.g. `js` after compiling TypeScript).
 * `moduleSideEffects` and `meta` are accepted and ignored.
 */
export type PluginTransformResult =
  | string
  | {
      code?: string;
      map?: SourceMapLike | string | null;
      moduleType?: PluginModuleType;
      moduleSideEffects?: unknown;
      meta?: unknown;
    }
  | null
  | undefined;

export interface SourceMapLike {
  version?: number;
  mappings: string;
  names?: string[];
  sources?: string[];
  sourcesContent?: (string | null)[];
}

/**
 * A runner plugin. Plugins live on the host: workers send the modules their
 * filters match to the runner, which runs the `transform` handlers and sends
 * the result back. Handlers run in `plugins` order within their `order` group:
 * `"pre"`, then unordered, then `"post"`. Other properties are ignored.
 */
export interface EnvRunnerPlugin {
  name?: string;
  transform:
    | PluginTransformHandler
    | {
        order?: "pre" | "post" | null;
        filter?: PluginTransformFilter | PluginTopLevelFilterExpression[];
        handler: PluginTransformHandler;
      };
}

/** `plugins` option entries: nested arrays are flattened, falsy ones skipped. */
export type EnvRunnerPluginOption =
  | EnvRunnerPlugin
  | EnvRunnerPluginOption[]
  | false
  | null
  | undefined;

/** Result of {@link PluginPipeline.transform}. */
export interface PluginTransformOutput {
  /** The new code, with an inline source map when a plugin returned one. */
  code: string;
  /**
   * `js`, or `ts` when no plugin compiled it (the worker strips the types
   * where the runtime does it natively, like for untransformed files).
   */
  moduleType: "js" | "ts";
}

/** The `plugins` option of a runner, ready to run on the host. */
export interface PluginPipeline {
  /** Plugin names, in `plugins` order. */
  names: string[];
  /** Each plugin's filter as the worker's prefilter checks it. */
  prefilters: SerializedPrefilter[];
  /**
   * Whether a module goes through the plugins: a disk module
   * ({@link isTransformCandidate}), or any id with a `moduleType`, and some
   * plugin's filter may match (its `code` parts aren't checked).
   */
  filter(id: string, moduleType?: PluginModuleType): boolean;
  /**
   * Run the plugins: `undefined` when none changed the code (load it as if
   * unmatched). Rejects with their errors (naming the plugin and id), and when
   * the code changed but is still neither JavaScript nor TypeScript (e.g. JSX
   * no plugin compiled).
   */
  transform(
    id: string,
    code: string,
    moduleType?: PluginModuleType,
  ): Promise<PluginTransformOutput | undefined>;
}

interface NormalizedPlugin {
  name: string;
  order: "pre" | "normal" | "post";
  prefilter: SerializedPrefilter;
  matches(id: string, moduleType: PluginModuleType, code?: string): boolean;
  handler: PluginTransformHandler;
}

/** Validate the `plugins` option (throws a descriptive `TypeError`). */
export function createPluginPipeline(
  plugins: EnvRunnerPluginOption[] | undefined,
): PluginPipeline | undefined {
  if (plugins == null) {
    return undefined;
  }
  if (!Array.isArray(plugins)) {
    throw new TypeError("[env-runner] `plugins` must be an array of plugin objects.");
  }
  const normalized = _flattenPlugins(plugins, "").map(([plugin, path]) =>
    _normalizePlugin(plugin, path),
  );
  const byOrder = (order: NormalizedPlugin["order"]) =>
    normalized.filter((plugin) => plugin.order === order);
  const ordered = [...byOrder("pre"), ...byOrder("normal"), ...byOrder("post")];

  const filter = (id: string, moduleType?: PluginModuleType) => {
    const path = normalizeFilterId(id);
    if (!moduleType) {
      if (!isTransformCandidate(path)) {
        return false;
      }
      moduleType = moduleTypeOf(path);
    }
    return normalized.some((plugin) => plugin.matches(path, moduleType));
  };

  const transform = async (id: string, code: string, sourceType?: PluginModuleType) => {
    id = stripQuery(id);
    const matchId = id.replaceAll("\\", "/");
    let moduleType = sourceType ?? moduleTypeOf(id);
    // Maps aren't composed: the first map is kept, a second one would be
    // relative to already-mapped code, so both are dropped. Code-only steps
    // keep the current map (they should preserve lines).
    let map: SourceMapLike | null | undefined;
    // Name of the plugin whose map was kept first.
    let mappedBy: string | undefined;
    let changed = false;
    for (const plugin of ordered) {
      if (!plugin.matches(matchId, moduleType, code)) {
        continue;
      }
      let result: PluginTransformResult;
      try {
        result = await plugin.handler.call(_createContext(plugin.name, id, code), code, id, {
          moduleType,
        });
      } catch (error: any) {
        const message = error?.message || String(error);
        // `this.error()` messages already name the plugin and id.
        throw message.startsWith("[env-runner]")
          ? error
          : new Error(`[env-runner] plugin "${plugin.name}" failed on "${id}": ${message}`, {
              cause: error,
            });
      }
      const next = typeof result === "string" ? result : (result?.code ?? code);
      if (typeof next !== "string") {
        throw new TypeError(
          `[env-runner] plugin "${plugin.name}" returned non-string \`code\` for "${id}" (got ${_describe(next)}): convert it to a string (e.g. \`s.toString()\`, with \`map: s.generateMap()\`).`,
        );
      }
      if (result && typeof result === "object") {
        moduleType = result.moduleType ?? moduleType;
      }
      if (next === code) {
        continue;
      }
      code = next;
      changed = true;
      const nextMap = typeof result === "object" ? _parseMap(result?.map) : undefined;
      if (nextMap) {
        if (mappedBy === undefined) {
          map = nextMap;
          mappedBy = plugin.name;
        } else {
          map = undefined;
          _warnDroppedMap(mappedBy, plugin.name);
        }
      }
    }
    if (!changed) {
      return undefined;
    }
    if (moduleType !== "js" && moduleType !== "ts") {
      throw new TypeError(
        `[env-runner] "${id}" is still ${moduleType} after its plugins: add one that compiles it to JavaScript (returning \`moduleType: "js"\`) or narrow the plugins' filters.`,
      );
    }
    if (map) {
      const source = isAbsolute(id) ? pathToFileURL(id).href : id;
      const json = JSON.stringify({ ...map, sources: [source], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return { code, moduleType: moduleType as "js" | "ts" };
  };

  return {
    names: normalized.map((plugin) => plugin.name),
    prefilters: normalized.map((plugin) => plugin.prefilter),
    filter,
    transform,
  };
}

// Initial module type of each virtual module code format.
const VIRTUAL_MODULE_TYPES: Partial<Record<string, PluginModuleType>> = {
  module: "js",
  commonjs: "js",
  "module-typescript": "ts",
  "commonjs-typescript": "ts",
  jsx: "jsx",
  tsx: "tsx",
};

/**
 * Transform the virtual modules plugins match, on the host before they are
 * sent: code formats, with the format as initial module type. A transformed
 * module stays in its format's module system (virtual `.ts`/`.tsx` stay ESM),
 * as TypeScript when no plugin compiled it.
 * Others, and untouched modules, are returned as they are.
 */
export async function transformVirtualModules<T extends ResolvedVirtualModule | null>(
  pipeline: PluginPipeline,
  modules: Record<string, T>,
): Promise<Record<string, T | ResolvedVirtualModule>> {
  const out: Record<string, T | ResolvedVirtualModule> = { ...modules };
  for (const [key, module] of Object.entries(modules)) {
    if (module === null) {
      continue;
    }
    const format = virtualModuleFormat(key, module);
    const moduleType = VIRTUAL_MODULE_TYPES[format];
    if (!moduleType || !pipeline.filter(key, moduleType)) {
      continue;
    }
    const source = typeof module === "string" ? module : (module.source as string);
    const result = await pipeline.transform(key, source, moduleType);
    if (result) {
      const system = format.startsWith("commonjs") ? "commonjs" : "module";
      out[key] = {
        source: result.code,
        format: result.moduleType === "ts" ? `${system}-typescript` : system,
      };
    }
  }
  return out;
}

// `[plugin, path]` pairs (`[1][0]`): nested arrays flattened, falsy entries skipped.
function _flattenPlugins(plugins: unknown[], path: string): [unknown, string][] {
  return plugins.flatMap((plugin, index): [unknown, string][] => {
    const at = `${path}[${index}]`;
    return Array.isArray(plugin) ? _flattenPlugins(plugin, at) : plugin ? [[plugin, at]] : [];
  });
}

type FilterFail = (key: string, reason: string) => never;

function _normalizePlugin(plugin: unknown, path: string): NormalizedPlugin {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] \`plugins${path}\` ${reason}: expected \`{ name?, transform }\`, where \`transform\` is a function or \`{ order?, filter?, handler }\`.`,
    );
  };
  const failFilter: FilterFail = (key, reason) => {
    throw new TypeError(
      `[env-runner] \`plugins${path}\` has an invalid \`transform.filter${key}\` ${reason}.`,
    );
  };
  if (typeof plugin !== "object") {
    return fail("is not a plugin object");
  }
  const { name: pluginName, transform: hook } = plugin as Partial<EnvRunnerPlugin>;
  const name = typeof pluginName === "string" ? pluginName : `plugins${path}`;
  let order: NormalizedPlugin["order"] = "normal";
  let filter: unknown;
  let handler: PluginTransformHandler;
  if (typeof hook === "function") {
    handler = hook;
  } else if (hook && typeof hook === "object" && typeof hook.handler === "function") {
    if (hook.order != null && hook.order !== "pre" && hook.order !== "post") {
      return fail(`has an invalid \`transform.order\` (${JSON.stringify(hook.order)})`);
    }
    order = hook.order ?? "normal";
    filter = hook.filter;
    handler = hook.handler;
  } else {
    return fail("has no `transform` function or `transform.handler`");
  }

  if (Array.isArray(filter)) {
    const expr = _normalizeExpressions(filter, failFilter);
    const test = compileFilterExpressions(expr);
    return {
      name,
      order,
      prefilter: { expr },
      // Without code (prefilter), a `code` expression may match.
      matches: (id, moduleType, code) => test(id, moduleType, code) !== false,
      handler,
    };
  }
  if (filter != null && typeof filter !== "object") {
    return failFilter(
      "",
      `(got ${_describe(filter)}): expected \`{ id?, code?, moduleType? }\` or an array of filter expressions`,
    );
  }
  const {
    id: idValue,
    code: codeValue,
    moduleType: moduleTypeValue,
  } = (filter ?? {}) as PluginTransformFilter;
  // Relative globs resolve from cwd now, for this process and the workers.
  const idPatterns = _stringFilter(idValue, ".id", failFilter);
  const id = idPatterns && {
    include: idPatterns.include.map(_idPattern),
    exclude: idPatterns.exclude.map(_idPattern),
  };
  const idTest =
    id &&
    compileFilter(
      id.include.map(deserializePattern),
      id.exclude.map(deserializePattern),
      (pattern, value) => pattern.test(value),
    );
  const codePatterns = _stringFilter(codeValue, ".code", failFilter);
  const code =
    codePatterns &&
    compileFilter(
      codePatterns.include.map(_codePattern),
      codePatterns.exclude.map(_codePattern),
      _matchCode,
    );
  const moduleTypes = _moduleTypes(moduleTypeValue, failFilter);
  return {
    name,
    order,
    prefilter: { id, moduleTypes },
    matches: (idValue, moduleType, codeValue) =>
      (!moduleTypes || moduleTypes.includes(moduleType)) &&
      (!idTest || idTest.test(idValue)) &&
      (codeValue === undefined || !code || code.test(codeValue)),
    handler,
  };
}

const _isPattern = (value: unknown): value is string | RegExp =>
  typeof value === "string" || value instanceof RegExp;

// A validated `id`/`code` filter (empty values are no filter).
function _stringFilter(
  filter: unknown,
  key: string,
  fail: FilterFail,
): { include: (string | RegExp)[]; exclude: (string | RegExp)[] } | undefined {
  if (!filter) {
    return undefined;
  }
  const toList = (value: unknown): (string | RegExp)[] => {
    const list = value ? (Array.isArray(value) ? value : [value]) : [];
    const invalid = list.find((pattern) => !_isPattern(pattern));
    if (invalid !== undefined) {
      fail(
        key,
        `(got ${_describe(invalid)}): expected strings or RegExps, as a value, an array or \`{ include, exclude }\``,
      );
    }
    return list;
  };
  if (typeof filter === "object" && !Array.isArray(filter) && !(filter instanceof RegExp)) {
    const { include, exclude } = filter as { include?: unknown; exclude?: unknown };
    return { include: toList(include), exclude: toList(exclude) };
  }
  return { include: toList(filter), exclude: [] };
}

function _moduleTypes(filter: unknown, fail: FilterFail): PluginModuleType[] | undefined {
  if (!filter) {
    return undefined;
  }
  const list = Array.isArray(filter)
    ? filter
    : typeof filter === "object"
      ? ((filter as { include?: unknown }).include ?? [])
      : undefined;
  if (!Array.isArray(list) || list.some((type) => typeof type !== "string")) {
    return fail(
      ".moduleType",
      `(got ${_describe(filter)}): expected an array of module types or \`{ include: [...] }\``,
    );
  }
  if (list.length === 0) {
    return fail(".moduleType", "(no module types): list at least one, or leave it out");
  }
  return list;
}

// Globs compiled (resolved from cwd), RegExps without stateful flags.
function _idPattern(pattern: string | RegExp): SerializedPattern {
  return typeof pattern === "string"
    ? { source: globToRegExp(resolveGlob(pattern)).source, flags: "", glob: true }
    : { source: pattern.source, flags: _statelessFlags(pattern) };
}

function _codePattern(pattern: string | RegExp): string | RegExp {
  return typeof pattern === "string"
    ? pattern
    : new RegExp(pattern.source, _statelessFlags(pattern));
}

// `g`/`y` make `test()` depend on `lastIndex`: match anywhere, every time.
function _statelessFlags(pattern: RegExp): string {
  return pattern.flags.replace(/[gy]/g, "");
}

function _normalizeExpressions(list: unknown[], fail: FilterFail): SerializedFilterExpression[] {
  return list.map((value: any, index) => {
    if (value?.kind !== "include" && value?.kind !== "exclude") {
      return fail(
        `[${index}]`,
        `(got ${_describe(value?.kind ?? value)}): expected an \`include\` or \`exclude\` expression`,
      );
    }
    return { kind: value.kind, expr: _normalizeNode(value.expr, `[${index}].expr`, fail) };
  });
}

function _normalizeNode(node: any, key: string, fail: FilterFail): SerializedFilterNode {
  const pattern = (allowed: (value: unknown) => boolean, expected: string) => {
    if (!allowed(node.pattern)) {
      fail(`${key}.pattern`, `(got ${_describe(node.pattern)}): expected ${expected}`);
    }
    return node.pattern;
  };
  switch (node?.kind) {
    case "and":
    case "or": {
      if (!Array.isArray(node.args) || node.args.length === 0) {
        return fail(key, `(\`${node.kind}\` needs at least one argument)`);
      }
      return {
        kind: node.kind,
        args: node.args.map((arg: unknown, index: number) =>
          _normalizeNode(arg, `${key}.args[${index}]`, fail),
        ),
      };
    }
    case "not": {
      return { kind: "not", expr: _normalizeNode(node.expr, `${key}.expr`, fail) };
    }
    case "id": {
      return { kind: "id", pattern: _idPattern(pattern(_isPattern, "a string or RegExp")) };
    }
    case "code": {
      const value = _codePattern(pattern(_isPattern, "a string or RegExp"));
      return {
        kind: "code",
        pattern: typeof value === "string" ? value : { source: value.source, flags: value.flags },
      };
    }
    case "moduleType": {
      return {
        kind: "moduleType",
        pattern: pattern((value) => typeof value === "string", "a string"),
      };
    }
    case "query": {
      if (typeof node.key !== "string") {
        return fail(`${key}.key`, `(got ${_describe(node.key)}): expected a string`);
      }
      const value = pattern(
        (value) => _isPattern(value) || typeof value === "boolean",
        "a string, RegExp or boolean",
      );
      return {
        kind: "query",
        key: node.key,
        pattern: value instanceof RegExp ? { source: value.source, flags: value.flags } : value,
      };
    }
    case "importerId": {
      return fail(key, "(`importerId` doesn't apply to `transform`)");
    }
    default: {
      return fail(key, `(got ${_describe(node?.kind ?? node)}): unknown expression kind`);
    }
  }
}

// A value's kind for error messages.
function _describe(value: unknown): string {
  if (value instanceof RegExp) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value && typeof value === "object") {
    const name = value.constructor?.name;
    return name && name !== "Object" ? name : "an object";
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function _createContext(name: string, id: string, code: string): PluginContext {
  const format = (log: PluginLog, pos?: PluginLogPosition) =>
    `[env-runner] plugin "${name}" (${id}${_formatPosition(code, pos)}): ${typeof log === "string" ? log : log?.message}`;
  return {
    warn: (log, pos) => console.warn(format(log, pos)),
    info: (log, pos) => console.info(format(log, pos)),
    debug: () => {},
    error: (log, pos) => {
      throw new Error(format(log, pos), typeof log === "string" ? undefined : { cause: log });
    },
  };
}

// `:line:column` of a log position (an offset is converted: 1-based line,
// 0-based column).
function _formatPosition(code: string, pos: PluginLogPosition | undefined): string {
  if (typeof pos === "number") {
    const before = code.slice(0, pos);
    return `:${before.split("\n").length}:${pos - before.lastIndexOf("\n") - 1}`;
  }
  return pos && typeof pos === "object" ? `:${pos.line}:${pos.column}` : "";
}

function _matchCode(pattern: string | RegExp, code: string): boolean {
  return typeof pattern === "string" ? code.includes(pattern) : pattern.test(code);
}

function _parseMap(map: SourceMapLike | string | null | undefined): SourceMapLike | undefined {
  if (typeof map === "string") {
    try {
      return JSON.parse(map);
    } catch {
      return undefined;
    }
  }
  return map ?? undefined;
}

const _warnedMaps = new Set<string>();

// Maps aren't composed: say so once per pair of plugins returning one.
function _warnDroppedMap(first: string, second: string): void {
  const key = `${first}\0${second}`;
  if (!_warnedMaps.has(key)) {
    _warnedMaps.add(key);
    console.warn(
      `[env-runner] plugins "${first}" and "${second}" both returned a source map; maps are not combined, so modules both change have none.`,
    );
  }
}
