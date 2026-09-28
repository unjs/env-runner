import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { virtualModuleFormat } from "../virtual-loader.ts";
import type { ResolvedVirtualModule } from "../virtual-loader.ts";
import {
  compileFilter,
  compileFilterExpressions,
  compilePrefilter,
  createPrefilter,
  isPluginFile,
  moduleTypeOf,
  normalizeFilterId,
  requiredMatch,
  satisfiesMatch,
  stripQuery,
} from "./filter.ts";
import type {
  PluginModuleType,
  PrefilterMatch,
  SerializedFilterExpression,
  SerializedFilterNode,
  SerializedPattern,
  SerializedPrefilter,
} from "./filter.ts";
import { globToRegExp, resolveGlob } from "./glob.ts";

export type { PluginModuleType } from "./filter.ts";

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
 * `resolveId` and `load` hook filter: `id` only, matched like
 * {@link PluginTransformFilter} `id`. For `resolveId` it is the import
 * specifier (without its query) and globs match it as written (not resolved
 * from the working directory).
 */
export interface PluginHookFilter {
  id?: PluginStringFilter;
}

/**
 * A filter expression, matched like the {@link PluginTransformFilter}
 * properties. `query` sees no query (only `pattern: false` matches), and
 * `importerId` is rejected. `resolveId` and `load` filters take no `code` or
 * `moduleType` expressions.
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

/** Passed to `resolveId` handlers. */
export interface PluginResolveIdOptions {
  /** Whether this is the runner's entry. */
  isEntry: boolean;
  /** Import attributes (`with { type: "json" }`), when the runtime reports them. */
  attributes: Record<string, string>;
}

/**
 * Runs on the host for the imports its filter matches (the import specifier
 * as written, `file:` URLs as paths) and may be async. `importer` is the
 * importing module's id (a path, or an id a `resolveId` returned), `undefined`
 * for the entry.
 */
export type PluginResolveIdHandler = (
  this: PluginContext,
  source: string,
  importer: string | undefined,
  options: PluginResolveIdOptions,
) => PluginResolveIdResult | Promise<PluginResolveIdResult>;

/**
 * The module's id, or nullish to try the next plugin (then the runtime
 * resolves it). An absolute path loads that file (through `load` hooks,
 * then from disk); any other id (like `\0virtual:foo`) must be loaded by a
 * `load` hook. `false` or `external` leaves the import (or the returned id)
 * to the runtime. `moduleSideEffects`, `meta` and other properties are
 * ignored.
 */
export type PluginResolveIdResult =
  | string
  | false
  | { id: string; external?: boolean | "absolute" | "relative"; [key: string]: unknown }
  | null
  | undefined;

/**
 * Runs on the host for the modules its filter matches and may be async:
 * return the module's code, or nullish to try the next plugin (then the file
 * is read from disk). `transform` hooks run on the result.
 */
export type PluginLoadHandler = (
  this: PluginContext,
  id: string,
) => PluginLoadResult | Promise<PluginLoadResult>;

/**
 * Code, or `{ code, map, moduleType }`: without a `moduleType`, it is the
 * id's ({@link PluginModuleType}), `js` for other extensions.
 * `moduleSideEffects` and `meta` are accepted and ignored.
 */
export type PluginLoadResult =
  | string
  | {
      code: string;
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

/** A hook: its handler, or `{ order, filter, handler }`. */
export type PluginHook<Handler, Filter> =
  | Handler
  | {
      order?: "pre" | "post" | null;
      filter?: Filter | PluginTopLevelFilterExpression[];
      handler: Handler;
    };

/**
 * A runner plugin. Plugins live on the host: workers send the imports and
 * modules their filters match to the runner, which runs the hooks and sends
 * the result back. Each hook runs in `plugins` order within its `order`
 * group: `"pre"`, then unordered, then `"post"`. Other properties (and hooks)
 * are ignored.
 *
 * - `resolveId`: resolve an import; the first result wins.
 * - `load`: provide a module's code; the first result wins.
 * - `transform`: change a module's code; every matching handler runs.
 */
export interface EnvRunnerPlugin {
  name?: string;
  resolveId?: PluginHook<PluginResolveIdHandler, PluginHookFilter>;
  load?: PluginHook<PluginLoadHandler, PluginHookFilter>;
  transform?: PluginHook<PluginTransformHandler, PluginTransformFilter>;
}

/** `plugins` option entries: nested arrays are flattened, falsy ones skipped. */
export type EnvRunnerPluginOption =
  | EnvRunnerPlugin
  | EnvRunnerPluginOption[]
  | false
  | null
  | undefined;

/** Result of {@link PluginPipeline.transform} and {@link PluginPipeline.load}. */
export interface PluginTransformOutput {
  /** The new code, with an inline source map when a plugin returned one. */
  code: string;
  /**
   * `js`; `ts` when no plugin compiled it (the worker strips the types where
   * the runtime does it natively, like for untransformed files); `json` for
   * JSON (served as a JSON module).
   */
  moduleType: "js" | "ts" | "json";
}

/** Result of {@link PluginPipeline.resolveId}. */
export interface PluginResolvedId {
  id: string;
  /** Leave the import (as `id`) to the runtime. */
  external: boolean;
}

/** The `plugins` option of a runner, ready to run on the host. */
export interface PluginPipeline {
  /** Plugin names, in `plugins` order. */
  names: string[];
  /** The `load` and `transform` filters as the worker's prefilter checks them. */
  prefilters: SerializedPrefilter[];
  /** The `resolveId` filters as the worker's prefilter checks them. */
  resolvePrefilters: SerializedPrefilter[];
  /**
   * Whether a module goes through the plugins: a disk module
   * ({@link isPluginFile}), or any id with a `moduleType`, and some `load` or
   * `transform` filter may match (its `code` parts aren't checked). Modules
   * of other than script types only match filters naming them (see
   * {@link requiredMatch}).
   */
  filter(id: string, moduleType?: PluginModuleType): boolean;
  /** Whether some `resolveId` filter matches an import specifier. */
  resolveFilter(source: string): boolean;
  /**
   * Run the `resolveId` hooks: the first result, or `undefined` when none
   * resolved it (the runtime resolves it). Rejects with their errors.
   */
  resolveId(
    source: string,
    importer?: string,
    options?: Partial<PluginResolveIdOptions>,
  ): Promise<PluginResolvedId | undefined>;
  /**
   * Run the `load` hooks, then the `transform` hooks on the loaded code. When
   * no `load` hook returned code, `read()` reads the module (none: rejects,
   * the id isn't a file), and the result is `undefined` when no plugin changed
   * it (load it as if unmatched). Rejects like {@link PluginPipeline.transform}.
   */
  load(id: string, read?: () => string): Promise<PluginTransformOutput | undefined>;
  /**
   * Run the `transform` hooks: `undefined` when none changed the code (load it
   * as if unmatched). Rejects with their errors (naming the plugin and id), and
   * when the code changed but is still neither JavaScript, TypeScript nor JSON
   * (e.g. JSX no plugin compiled).
   */
  transform(
    id: string,
    code: string,
    moduleType?: PluginModuleType,
  ): Promise<PluginTransformOutput | undefined>;
}

type HookKind = "resolveId" | "load" | "transform";

interface NormalizedHook<Handler> {
  name: string;
  order: "pre" | "normal" | "post";
  prefilter: SerializedPrefilter;
  /** The full filter (code-aware for `transform`), see {@link PrefilterMatch}. */
  match(id: string, moduleType: PluginModuleType, code?: string): PrefilterMatch;
  handler: Handler;
}

interface NormalizedPlugin {
  name: string;
  resolveId?: NormalizedHook<PluginResolveIdHandler>;
  load?: NormalizedHook<PluginLoadHandler>;
  transform?: NormalizedHook<PluginTransformHandler>;
}

// Module types a result may leave without a `moduleType` (others become `js`).
const KNOWN_MODULE_TYPES: readonly string[] = ["js", "jsx", "ts", "tsx", "json"];

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
  const ordered = <K extends HookKind>(kind: K) => {
    const hooks = normalized.flatMap((plugin) => (plugin[kind] ? [plugin[kind]!] : []));
    const byOrder = (order: NormalizedHook<unknown>["order"]) =>
      hooks.filter((hook) => hook.order === order);
    return [...byOrder("pre"), ...byOrder("normal"), ...byOrder("post")] as NonNullable<
      NormalizedPlugin[K]
    >[];
  };
  const resolveHooks = ordered("resolveId");
  const loadHooks = ordered("load");
  const transformHooks = ordered("transform");
  const prefilters = normalized.flatMap((plugin) =>
    [plugin.load, plugin.transform].flatMap((hook) => (hook ? [hook.prefilter] : [])),
  );
  const resolvePrefilters = resolveHooks.map((hook) => hook.prefilter);
  const prefilter = createPrefilter(prefilters);
  const resolvePrefilter = createPrefilter(resolvePrefilters);

  const filter = (id: string, moduleType?: PluginModuleType) => {
    const path = normalizeFilterId(id);
    if (!moduleType) {
      if (!isPluginFile(path)) {
        return false;
      }
      moduleType = moduleTypeOf(path);
    }
    return prefilter(path, moduleType);
  };

  const resolveId = async (
    source: string,
    importer?: string,
    options?: Partial<PluginResolveIdOptions>,
  ): Promise<PluginResolvedId | undefined> => {
    const matchId = normalizeFilterId(source);
    const extra: PluginResolveIdOptions = {
      isEntry: options?.isEntry ?? false,
      attributes: options?.attributes ?? {},
    };
    for (const hook of resolveHooks) {
      if (!hook.match(matchId, "js")) {
        continue;
      }
      const result = await _callHook(hook.name, `failed to resolve "${source}"`, () =>
        hook.handler.call(_createContext(hook.name, source, ""), source, importer, extra),
      );
      if (result == null) {
        continue;
      }
      if (result === false) {
        return { id: source, external: true };
      }
      const id = typeof result === "string" ? result : result.id;
      if (typeof id !== "string" || id === "") {
        throw new TypeError(
          `[env-runner] plugin "${hook.name}" resolved "${source}" to an invalid id (got ${_describe(id)}): return a string, \`{ id }\` or nullish.`,
        );
      }
      return { id, external: typeof result === "object" && Boolean(result.external) };
    }
    return undefined;
  };

  const load = async (id: string, read?: () => string) => {
    const matchId = normalizeFilterId(id);
    let moduleType = moduleTypeOf(id);
    // Plugin ids (no `read`) have no fallback: every matching hook may load
    // them, whatever their extension.
    const required = read ? requiredMatch(moduleType) : undefined;
    for (const hook of loadHooks) {
      if (!satisfiesMatch(hook.match(matchId, moduleType), required)) {
        continue;
      }
      const result = await _callHook(hook.name, `failed to load "${id}"`, () =>
        hook.handler.call(_createContext(hook.name, id, ""), id),
      );
      if (result == null) {
        continue;
      }
      const code = typeof result === "string" ? result : result.code;
      if (typeof code !== "string") {
        throw new TypeError(
          `[env-runner] plugin "${hook.name}" loaded non-string \`code\` for "${id}" (got ${_describe(code)}).`,
        );
      }
      const map = typeof result === "object" ? _parseMap(result.map) : undefined;
      if (typeof result === "object" && result.moduleType) {
        moduleType = result.moduleType;
      } else if (!KNOWN_MODULE_TYPES.includes(moduleType)) {
        moduleType = "js";
      }
      return _transform(id, code, moduleType, {
        changed: true,
        map,
        mappedBy: map ? hook.name : undefined,
      });
    }
    if (!read) {
      throw new Error(
        `[env-runner] no plugin loaded "${id}": a \`resolveId\` hook resolved an import to it, so a \`load\` hook must return its code.`,
      );
    }
    if (!filter(id)) {
      return undefined;
    }
    return _transform(id, read(), moduleType, { changed: false });
  };

  // The `transform` hooks, from the code of `id`.
  const _transform = async (
    id: string,
    code: string,
    moduleType: PluginModuleType,
    // Maps aren't composed: the first map is kept, a second one would be
    // relative to already-mapped code, so both are dropped. Code-only steps
    // keep the current map (they should preserve lines).
    state: { changed: boolean; map?: SourceMapLike; mappedBy?: string },
  ): Promise<PluginTransformOutput | undefined> => {
    let { changed, map, mappedBy } = state;
    const matchId = normalizeFilterId(id);
    for (const hook of transformHooks) {
      if (!satisfiesMatch(hook.match(matchId, moduleType, code), requiredMatch(moduleType))) {
        continue;
      }
      const result = await _callHook(hook.name, `failed on "${id}"`, () =>
        hook.handler.call(_createContext(hook.name, id, code), code, id, { moduleType }),
      );
      const next = typeof result === "string" ? result : (result?.code ?? code);
      if (typeof next !== "string") {
        throw new TypeError(
          `[env-runner] plugin "${hook.name}" returned non-string \`code\` for "${id}" (got ${_describe(next)}): convert it to a string (e.g. \`s.toString()\`, with \`map: s.generateMap()\`).`,
        );
      }
      const resultType = result && typeof result === "object" ? result.moduleType : undefined;
      if (resultType) {
        moduleType = resultType;
      }
      if (next === code) {
        continue;
      }
      code = next;
      changed = true;
      // A plugin turning another file type into code without saying which.
      if (!resultType && !KNOWN_MODULE_TYPES.includes(moduleType)) {
        moduleType = "js";
      }
      const nextMap = typeof result === "object" ? _parseMap(result?.map) : undefined;
      if (nextMap) {
        if (mappedBy === undefined) {
          map = nextMap;
          mappedBy = hook.name;
        } else {
          map = undefined;
          _warnDroppedMap(mappedBy, hook.name);
        }
      }
    }
    if (!changed) {
      return undefined;
    }
    if (moduleType === "json") {
      // JSON a plugin rewrote as code, without saying so.
      try {
        JSON.parse(code);
        return { code, moduleType: "json" };
      } catch {
        moduleType = "js";
      }
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

  const transform = (id: string, code: string, sourceType?: PluginModuleType) => {
    id = stripQuery(id);
    return _transform(id, code, sourceType ?? moduleTypeOf(id), { changed: false });
  };

  return {
    names: normalized.map((plugin) => plugin.name),
    prefilters,
    resolvePrefilters,
    filter,
    resolveFilter: (source) => resolvePrefilter(normalizeFilterId(source), "js"),
    resolveId,
    load,
    transform,
  };
}

// Run a handler; errors name the plugin (`this.error()` messages already do).
async function _callHook<T>(name: string, what: string, call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: any) {
    const message = error?.message || String(error);
    throw message.startsWith("[env-runner]")
      ? error
      : new Error(`[env-runner] plugin "${name}" ${what}: ${message}`, { cause: error });
  }
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

const HOOK_KINDS: HookKind[] = ["resolveId", "load", "transform"];

function _normalizePlugin(plugin: unknown, path: string): NormalizedPlugin {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] \`plugins${path}\` ${reason}: expected a plugin object with \`resolveId\`, \`load\` or \`transform\` hooks, each a function or \`{ order?, filter?, handler }\`.`,
    );
  };
  if (typeof plugin !== "object") {
    return fail("is not a plugin object");
  }
  const { name: pluginName } = plugin as Partial<EnvRunnerPlugin>;
  const name = typeof pluginName === "string" ? pluginName : `plugins${path}`;
  const normalized: NormalizedPlugin = { name };
  for (const kind of HOOK_KINDS) {
    const hook = (plugin as Record<string, unknown>)[kind];
    if (hook != null) {
      (normalized as any)[kind] = _normalizeHook(kind, hook, name, path, fail);
    }
  }
  return normalized;
}

function _normalizeHook(
  kind: HookKind,
  hook: unknown,
  name: string,
  path: string,
  fail: (reason: string) => never,
): NormalizedHook<any> {
  const failFilter: FilterFail = (key, reason) => {
    throw new TypeError(
      `[env-runner] \`plugins${path}\` has an invalid \`${kind}.filter${key}\` ${reason}.`,
    );
  };
  let order: NormalizedHook<unknown>["order"] = "normal";
  let filter: unknown;
  let handler: (...args: any[]) => unknown;
  if (typeof hook === "function") {
    handler = hook as typeof handler;
  } else if (hook && typeof hook === "object" && typeof (hook as any).handler === "function") {
    const object = hook as { order?: unknown; filter?: unknown; handler: typeof handler };
    if (object.order != null && object.order !== "pre" && object.order !== "post") {
      return fail(`has an invalid \`${kind}.order\` (${JSON.stringify(object.order)})`);
    }
    order = (object.order as "pre" | "post" | undefined) ?? "normal";
    filter = object.filter;
    handler = object.handler;
  } else {
    return fail(`has an invalid \`${kind}\` hook (got ${_describe(hook)})`);
  }
  // `load` filters can't name module types: a matching `id` include does.
  const load = kind === "load" ? { load: true as const } : {};

  if (Array.isArray(filter)) {
    const expr = _normalizeExpressions(filter, kind, failFilter);
    const test = compileFilterExpressions(expr);
    const prefilter: SerializedPrefilter = { expr, ...load };
    const level = compilePrefilter(prefilter);
    return {
      name,
      order,
      prefilter,
      // Without code (prefilter), a `code` expression may match.
      match: (id, moduleType, code) =>
        test(id, moduleType, code) !== false && level(id, moduleType),
      handler,
    };
  }
  const keys = kind === "transform" ? "`{ id?, code?, moduleType? }`" : "`{ id? }`";
  if (filter != null && typeof filter !== "object") {
    return failFilter(
      "",
      `(got ${_describe(filter)}): expected ${keys} or an array of filter expressions`,
    );
  }
  const {
    id: idValue,
    code: codeValue,
    moduleType: moduleTypeValue,
  } = (filter ?? {}) as PluginTransformFilter;
  if (kind !== "transform") {
    for (const [key, value] of [
      ["code", codeValue],
      ["moduleType", moduleTypeValue],
    ] as const) {
      if (value) {
        failFilter(`.${key}`, `(\`${kind}\` filters take \`id\` only)`);
      }
    }
  }
  // Relative globs resolve from cwd now, for this process and the workers
  // (not for `resolveId`, which matches specifiers).
  const idPatterns = _stringFilter(idValue, ".id", failFilter);
  const toPattern = (pattern: string | RegExp) => _idPattern(pattern, kind !== "resolveId");
  const id = idPatterns && {
    include: idPatterns.include.map(toPattern),
    exclude: idPatterns.exclude.map(toPattern),
  };
  const codePatterns = _stringFilter(codeValue, ".code", failFilter);
  const code =
    codePatterns &&
    compileFilter(
      codePatterns.include.map(_codePattern),
      codePatterns.exclude.map(_codePattern),
      _matchCode,
    );
  const moduleTypes = _moduleTypes(moduleTypeValue, failFilter);
  const prefilter: SerializedPrefilter = { id, moduleTypes, ...load };
  const level = compilePrefilter(prefilter);
  return {
    name,
    order,
    prefilter,
    match: (idValue, moduleType, codeValue) =>
      (codeValue === undefined || !code || code.test(codeValue)) && level(idValue, moduleType),
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

// Globs compiled (resolved from cwd with `resolve`), RegExps without stateful flags.
function _idPattern(pattern: string | RegExp, resolve = true): SerializedPattern {
  return typeof pattern === "string"
    ? {
        source: globToRegExp(resolve ? resolveGlob(pattern) : pattern).source,
        flags: "",
        glob: true,
      }
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

function _normalizeExpressions(
  list: unknown[],
  kind: HookKind,
  fail: FilterFail,
): SerializedFilterExpression[] {
  return list.map((value: any, index) => {
    if (value?.kind !== "include" && value?.kind !== "exclude") {
      return fail(
        `[${index}]`,
        `(got ${_describe(value?.kind ?? value)}): expected an \`include\` or \`exclude\` expression`,
      );
    }
    return {
      kind: value.kind,
      expr: _normalizeNode(value.expr, `[${index}].expr`, kind, fail),
    };
  });
}

function _normalizeNode(
  node: any,
  key: string,
  hook: HookKind,
  fail: FilterFail,
): SerializedFilterNode {
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
          _normalizeNode(arg, `${key}.args[${index}]`, hook, fail),
        ),
      };
    }
    case "not": {
      return { kind: "not", expr: _normalizeNode(node.expr, `${key}.expr`, hook, fail) };
    }
    case "id": {
      return {
        kind: "id",
        pattern: _idPattern(pattern(_isPattern, "a string or RegExp"), hook !== "resolveId"),
      };
    }
    case "code": {
      if (hook !== "transform") {
        return fail(key, `(\`code\` doesn't apply to \`${hook}\`)`);
      }
      const value = _codePattern(pattern(_isPattern, "a string or RegExp"));
      return {
        kind: "code",
        pattern: typeof value === "string" ? value : { source: value.source, flags: value.flags },
      };
    }
    case "moduleType": {
      if (hook !== "transform") {
        return fail(key, `(\`moduleType\` doesn't apply to \`${hook}\`)`);
      }
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
      return fail(key, `(\`importerId\` isn't supported)`);
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
