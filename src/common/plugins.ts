import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { virtualModuleFormat } from "../virtual-loader.ts";
import type { ResolvedVirtualModule } from "../virtual-loader.ts";
import {
  compileFilter,
  isTransformCandidate,
  matchId,
  moduleTypeOf,
  normalizeFilterId,
  resolveGlob,
  serializePattern,
  stripQuery,
  testRegExp,
} from "./plugin-filter.ts";
import type { CompiledFilter, PluginModuleType, SerializedPrefilter } from "./plugin-filter.ts";

export type { PluginModuleType } from "./plugin-filter.ts";

type MaybeArray<T> = T | T[];

/** Include values, or `{ include, exclude }` (exclude wins). */
export type PluginStringFilter =
  | MaybeArray<string | RegExp>
  | { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };

/**
 * `transform` hook filter (all given properties must match).
 * - `id`: strings are globs (`path.matchesGlob`; relative ones resolve from
 *   cwd), RegExps are tested; both against the `/`-separated id.
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

/** Passed to every handler. */
export interface PluginTransformMeta {
  /** Language of `code` (updated by results returning a `moduleType`). */
  moduleType: PluginModuleType;
}

/** `this` in handlers. Messages are prefixed with the plugin name and module id. */
export interface PluginContext {
  /** Log a warning (on the host). */
  warn(message: string | { message: string }): void;
  /** Throw an error (an `Error` given is kept as its `cause`). */
  error(message: string | { message: string }): never;
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
 */
export type PluginTransformResult =
  | string
  | { code?: string; map?: SourceMapLike | string | null; moduleType?: PluginModuleType }
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
 * `"pre"`, then unordered, then `"post"`.
 */
export interface EnvRunnerPlugin {
  name?: string;
  transform:
    | PluginTransformHandler
    | {
        order?: "pre" | "post" | null;
        filter?: PluginTransformFilter;
        handler: PluginTransformHandler;
      };
}

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

/** The `data.plugins` of a runner, ready to run on the host. */
export interface PluginPipeline {
  /** Plugin names, in `plugins` order. */
  names: string[];
  /** Each plugin's `id`/`moduleType` filter, for the worker's prefilter. */
  prefilters: SerializedPrefilter[];
  /**
   * Whether a module goes through the plugins: a disk module
   * ({@link isTransformCandidate}), or any id with a `moduleType`, and some
   * plugin's `id`/`moduleType` filter matches.
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

/** Validate `data.plugins` (throws a descriptive `TypeError`). */
export function createPluginPipeline(
  plugins: EnvRunnerPlugin[] | undefined,
): PluginPipeline | undefined {
  if (plugins == null) {
    return undefined;
  }
  if (!Array.isArray(plugins)) {
    throw new TypeError("[env-runner] `data.plugins` must be an array of plugin objects.");
  }
  const normalized = plugins.map((plugin, index) => _normalizePlugin(plugin, index));
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
        result = await plugin.handler.call(_createContext(plugin.name, id), code, id, {
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
          `[env-runner] plugin "${plugin.name}" returned non-string \`code\` for "${id}".`,
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

function _normalizePlugin(plugin: unknown, index: number): NormalizedPlugin {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] \`data.plugins[${index}]\` ${reason}: expected \`{ name?, transform }\`, where \`transform\` is a function or \`{ order?, filter?, handler }\`.`,
    );
  };
  if (!plugin || typeof plugin !== "object") {
    return fail("is not a plugin object");
  }
  const { name: pluginName, transform: hook } = plugin as Partial<EnvRunnerPlugin>;
  const name = typeof pluginName === "string" ? pluginName : `plugins[${index}]`;
  let order: NormalizedPlugin["order"] = "normal";
  let filter: PluginTransformFilter | undefined;
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

  // Relative globs resolve from cwd now, like the worker's prefilter.
  const id =
    filter?.id === undefined
      ? undefined
      : _compileStringFilter(filter.id, matchId, (pattern) =>
          typeof pattern === "string" ? resolveGlob(pattern) : pattern,
        );
  const code =
    filter?.code === undefined ? undefined : _compileStringFilter(filter.code, _matchCode);
  const moduleTypeFilter = filter?.moduleType;
  const moduleTypes = Array.isArray(moduleTypeFilter)
    ? moduleTypeFilter
    : moduleTypeFilter === undefined
      ? undefined
      : moduleTypeFilter?.include;
  if (moduleTypeFilter !== undefined && !Array.isArray(moduleTypes)) {
    return fail(
      "has an invalid `transform.filter.moduleType` (expected an array or `{ include: [...] }`)",
    );
  }
  return {
    name,
    order,
    prefilter: {
      id: id && {
        include: id.include.map(serializePattern),
        exclude: id.exclude.map(serializePattern),
      },
      moduleTypes,
    },
    matches: (idValue, moduleType, codeValue) =>
      (!moduleTypes || moduleTypes.includes(moduleType)) &&
      (!id || id.test(idValue)) &&
      (codeValue === undefined || !code || code.test(codeValue)),
    handler,
  };
}

function _createContext(name: string, id: string): PluginContext {
  const format = (message: string | { message: string }) =>
    `[env-runner] plugin "${name}" (${id}): ${typeof message === "string" ? message : message?.message}`;
  return {
    warn: (message) => console.warn(format(message)),
    error: (message) => {
      throw new Error(
        format(message),
        typeof message === "string" ? undefined : { cause: message },
      );
    },
  };
}

function _compileStringFilter(
  filter: PluginStringFilter,
  match: (pattern: string | RegExp, value: string) => boolean,
  map: (pattern: string | RegExp) => string | RegExp = (pattern) => pattern,
): CompiledFilter<string | RegExp> {
  const formal =
    filter && typeof filter === "object" && !Array.isArray(filter) && !(filter instanceof RegExp);
  const toList = (value: MaybeArray<string | RegExp> | undefined) =>
    (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(map);
  return compileFilter(
    formal ? toList(filter.include) : toList(filter as MaybeArray<string | RegExp>),
    formal ? toList(filter.exclude) : [],
    match,
  );
}

function _matchCode(pattern: string | RegExp, code: string): boolean {
  return typeof pattern === "string" ? code.includes(pattern) : testRegExp(pattern, code);
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
