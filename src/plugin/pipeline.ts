import { isBuiltin } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveModulePath } from "exsolve";
import { virtualModuleFormat } from "../virtual-loader.ts";
import type { ResolvedVirtualModule } from "../virtual-loader.ts";
import {
  compileFilter,
  compileFilterExpressions,
  compilePrefilter,
  createPrefilter,
  moduleTypeOf,
  normalizeFilterId,
  queryOf,
  requiredMatch,
  satisfiesMatch,
  stripQuery,
} from "./filter.ts";
import type {
  PluginModuleType,
  PrefilterMatch,
  PrefilterTest,
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
 * ignored). Ids are matched `/`-separated and with their query string: the
 * glob `**\/*.svg` and the RegExp `/\.svg$/` don't match `/app/a.svg?raw`, but
 * `/\.svg(?:\?.*)?$/` does (or add a `query` filter expression).
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
 * specifier (with its query) and globs match it as written (not resolved
 * from the working directory).
 */
export interface PluginHookFilter {
  id?: PluginStringFilter;
}

/**
 * A filter expression, matched like the {@link PluginTransformFilter}
 * properties. `query` parses the id's query with `URLSearchParams`: `true`
 * matches when `key` is present (`?raw`), `false` when it's absent, a string
 * equals its value, a RegExp tests it (`""` when absent). `importerId` is
 * rejected. `resolveId` and `load` filters take no `code` or `moduleType`
 * expressions.
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

/**
 * A message for {@link PluginContext}: a string, or a log object. A log's
 * `loc` (1-based line, 0-based column) or `pos` (an offset) is used when no
 * position is given, and its `frame` is shown below the message.
 */
export type PluginLog =
  | string
  | {
      message: string;
      loc?: { line: number; column: number; file?: string };
      pos?: number;
      frame?: string;
    };

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
  /**
   * Throw an error (an `Error` or log object given is kept as its `cause`).
   * Errors a handler throws are reported the same way, with their `loc`,
   * `pos` and `frame`.
   */
  error(log: PluginLog, pos?: PluginLogPosition): never;
  /**
   * Resolve an import like the runner would, on the host: the `resolveId`
   * hooks (with `skipSelf`, the default, without the calling plugin's), then
   * Node.js ESM resolution from `importer` (or the working directory) with
   * the runner's export conditions: a file path, a builtin (`external`), or
   * `null` when it doesn't resolve. No extensions or directory indexes are
   * tried, as in Node.js.
   */
  resolve(
    source: string,
    importer?: string,
    options?: PluginContextResolveOptions,
  ): Promise<PluginResolvedId | null>;
  /** Ignored: the runner doesn't watch files (nothing is ever returned). */
  addWatchFile(id: string): void;
  /** Always empty (see `addWatchFile`). */
  getWatchFiles(): string[];
  /** `watchMode` is `false`: plugins aren't told about file changes. */
  meta: { watchMode: boolean };
}

/**
 * Runs on the host and may be async. Return nullish to keep the code. `id` is
 * the module's path with the import's query (`/app/a.ts?raw`), or an id a
 * `resolveId` hook returned.
 */
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

/** Options of {@link PluginContext.resolve}. */
export interface PluginContextResolveOptions {
  /**
   * Skip the calling plugin's `resolveId` hook, also when other plugins call
   * `this.resolve()` with the same source and importer meanwhile (default
   * `true`; only for calls from `resolveId`).
   */
  skipSelf?: boolean;
  isEntry?: boolean;
  attributes?: Record<string, string>;
}

/** Passed to `resolveId` handlers. */
export interface PluginResolveIdOptions {
  /** Whether this is the runner's entry. */
  isEntry: boolean;
  /** Import attributes (`with { type: "json" }`), when the runtime reports them. */
  attributes: Record<string, string>;
}

/**
 * Runs on the host for the imports its filter matches (the import specifier
 * as written, with its query, `file:` URLs as paths) and may be async.
 * `importer` is the importing module's id (a path with its query, or an id a
 * `resolveId` returned), `undefined` for the entry.
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
 * is read from disk, without the id's query). `transform` hooks run on the
 * result. `id` is like the {@link PluginTransformHandler} one.
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
 * group: `"pre"`, then unordered, then `"post"` (plugins are sorted by
 * `enforce` first). Other properties (and hooks) are ignored.
 *
 * - `resolveId`: resolve an import; the first result wins.
 * - `load`: provide a module's code; the first result wins.
 * - `transform`: change a module's code; every matching handler runs.
 */
export interface EnvRunnerPlugin {
  name?: string;
  /**
   * Orders the whole plugin: `"pre"` plugins come first and `"post"` last,
   * keeping `plugins` order within each group. Each hook's own `order`
   * applies on top of that.
   */
  enforce?: "pre" | "post";
  resolveId?: PluginResolveIdHook;
  load?: PluginHook<PluginLoadHandler, PluginHookFilter>;
  transform?: PluginHook<PluginTransformHandler, PluginTransformFilter>;
}

/**
 * A `resolveId` hook. With `fallback: true`, it only runs for imports the
 * runtime fails to resolve (the worker tries first, so imports it resolves
 * take no round trip), after the other `resolveId` hooks, which run before
 * the runtime.
 */
export type PluginResolveIdHook =
  | PluginResolveIdHandler
  | {
      order?: "pre" | "post" | null;
      filter?: PluginHookFilter | PluginTopLevelFilterExpression[];
      fallback?: boolean;
      handler: PluginResolveIdHandler;
    };

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

/** Options of {@link PluginPipeline.resolveId}. */
export interface PluginResolveIdCallOptions extends Partial<PluginResolveIdOptions> {
  /** Run the `fallback` hooks: the runtime failed to resolve the import. */
  fallback?: boolean;
}

/** Result of {@link PluginPipeline.resolveId}. */
// A type (not an interface): `resolveId` handlers can return it as it is.
export type PluginResolvedId = {
  id: string;
  /** Leave the import (as `id`) to the runtime. */
  external: boolean;
};

/** The `plugins` option of a runner, ready to run on the host. */
export interface PluginPipeline {
  /** Plugin names, in `plugins` order. */
  names: string[];
  /** The `load` and `transform` filters as the worker's prefilter checks them. */
  prefilters: SerializedPrefilter[];
  /** The `resolveId` filters as the worker's prefilter checks them. */
  resolvePrefilters: SerializedPrefilter[];
  /**
   * Whether a module goes through the plugins: some `load` or `transform`
   * filter may match (its `code` parts aren't checked). Modules of other than
   * script types only match filters naming them (see {@link requiredMatch}),
   * and disk modules under `/node_modules/` only ones naming that, unless
   * `resolved` (a `resolveId` hook returned the path) or an id with a
   * `moduleType` (virtual modules) is given.
   */
  filter(id: string, moduleType?: PluginModuleType, resolved?: boolean): boolean;
  /**
   * Whether some `resolveId` filter matches an import specifier (`fallback`:
   * of the hooks for imports the runtime can't resolve).
   */
  resolveFilter(source: string, fallback?: boolean): boolean;
  /**
   * Run the `resolveId` hooks (`fallback`: those for imports the runtime
   * failed to resolve): the first result, or `undefined` when none resolved
   * it (the runtime resolves it, or fails). Rejects with their errors.
   */
  resolveId(
    source: string,
    importer?: string,
    options?: PluginResolveIdCallOptions,
  ): Promise<PluginResolvedId | undefined>;
  /**
   * Run the `load` hooks, then the `transform` hooks on the loaded code. When
   * no `load` hook returned code, `read()` reads the module (none: rejects,
   * the id isn't a file), and the result is `undefined` when no plugin changed
   * it (load it as if unmatched). Rejects like {@link PluginPipeline.transform}.
   */
  load(
    id: string,
    read?: () => string,
    options?: { resolved?: boolean },
  ): Promise<PluginTransformOutput | undefined>;
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
  /** A `resolveId` hook for imports the runtime can't resolve. */
  fallback?: boolean;
  /**
   * The full filter (code-aware for `transform`), see {@link PrefilterMatch}
   * (`resolved`: see {@link PrefilterTest}).
   */
  match(
    id: string,
    moduleType: PluginModuleType,
    code?: string,
    resolved?: boolean,
  ): PrefilterMatch;
  handler: Handler;
}

// A `resolveId` hook `this.resolve()` skips (see `skipSelf`).
interface ResolveSkip {
  hook: NormalizedHook<unknown>;
  source: string;
  importer: string | undefined;
}

interface NormalizedPlugin {
  name: string;
  enforce: "pre" | "normal" | "post";
  resolveId?: NormalizedHook<PluginResolveIdHandler>;
  load?: NormalizedHook<PluginLoadHandler>;
  transform?: NormalizedHook<PluginTransformHandler>;
}

// Module types a result may leave without a `moduleType` (others become `js`).
const KNOWN_MODULE_TYPES: readonly string[] = ["js", "jsx", "ts", "tsx", "json"];

/**
 * Validate the `plugins` option (throws a descriptive `TypeError`):
 * `undefined` when it has no `resolveId`, `load` or `transform` hook.
 */
export function createPluginPipeline(
  plugins: EnvRunnerPluginOption[] | undefined,
  options: {
    /** Export conditions of `this.resolve()` without a plugin result (Node.js's by default). */
    resolveConditions?: () => string[] | undefined;
  } = {},
): PluginPipeline | undefined {
  const { resolveConditions } = options;
  if (plugins == null) {
    return undefined;
  }
  if (!Array.isArray(plugins)) {
    throw new TypeError("[env-runner] `plugins` must be an array of plugin objects.");
  }
  const normalized = _flattenPlugins(plugins, "").map(([plugin, path]) =>
    _normalizePlugin(plugin, path),
  );
  // `enforce` groups (a stable sort keeps `plugins` order within each).
  const rank = { pre: 0, normal: 1, post: 2 };
  const enforced = normalized.toSorted((a, b) => rank[a.enforce] - rank[b.enforce]);
  const ordered = <K extends HookKind>(kind: K) => {
    const hooks = enforced.flatMap((plugin) => (plugin[kind] ? [plugin[kind]!] : []));
    const byOrder = (order: NormalizedHook<unknown>["order"]) =>
      hooks.filter((hook) => hook.order === order);
    return [...byOrder("pre"), ...byOrder("normal"), ...byOrder("post")] as NonNullable<
      NormalizedPlugin[K]
    >[];
  };
  const resolveHooks = ordered("resolveId");
  const loadHooks = ordered("load");
  const transformHooks = ordered("transform");
  // No hook to run (`plugins: []`, only falsy entries or unsupported hooks):
  // as without `plugins`.
  if (resolveHooks.length + loadHooks.length + transformHooks.length === 0) {
    return undefined;
  }
  const prefilters = normalized.flatMap((plugin) =>
    [plugin.load, plugin.transform].flatMap((hook) => (hook ? [hook.prefilter] : [])),
  );
  const resolvePrefilters = resolveHooks.map((hook) => hook.prefilter);
  const fallbackPrefilter = createPrefilter(
    resolvePrefilters.filter((prefilter) => prefilter.fallback),
  );
  const prefilter = createPrefilter(prefilters);
  const resolvePrefilter = createPrefilter(
    resolvePrefilters.filter((prefilter) => !prefilter.fallback),
  );

  const filter = (id: string, moduleType?: PluginModuleType, resolved?: boolean) => {
    const matchId = normalizeFilterId(id);
    return prefilter(
      matchId,
      moduleType ?? moduleTypeOf(matchId),
      resolved || moduleType !== undefined,
    );
  };

  // `this.resolve()` of a handler (`caller`: a `resolveId` hook, skipped with
  // `skipSelf`, also in nested calls for the same source and importer).
  const contextResolve =
    (caller: NormalizedHook<unknown> | undefined, skip: readonly ResolveSkip[]) =>
    async (
      source: string,
      importer?: string,
      options: PluginContextResolveOptions = {},
    ): Promise<PluginResolvedId | null> => {
      if (typeof source !== "string") {
        throw new TypeError(
          `[env-runner] \`this.resolve()\` needs a string (got ${_describe(source)}).`,
        );
      }
      const skipping =
        caller && options.skipSelf !== false ? [...skip, { hook: caller, source, importer }] : skip;
      const skipped = new Set(
        skipping
          .filter((entry) => entry.source === source && entry.importer === importer)
          .map((entry) => entry.hook),
      );
      const { skipSelf: _, ...rest } = options;
      return (
        (await _resolveId(source, importer, rest, skipped, skipping)) ??
        _resolveLikeRuntime(source, importer, resolveConditions?.()) ??
        (await _resolveId(source, importer, { ...rest, fallback: true }, skipped, skipping)) ??
        null
      );
    };

  const _resolveId = async (
    source: string,
    importer: string | undefined,
    options: PluginResolveIdCallOptions | undefined,
    skipped: ReadonlySet<NormalizedHook<unknown>>,
    skip: readonly ResolveSkip[],
  ): Promise<PluginResolvedId | undefined> => {
    const matchId = normalizeFilterId(source);
    const extra: PluginResolveIdOptions = {
      isEntry: options?.isEntry ?? false,
      attributes: options?.attributes ?? {},
    };
    for (const hook of resolveHooks) {
      // The `node_modules` rule is for modules, not specifiers.
      if (
        Boolean(hook.fallback) !== Boolean(options?.fallback) ||
        skipped.has(hook) ||
        !hook.match(matchId, "js", undefined, true)
      ) {
        continue;
      }
      const context = _createContext(hook.name, source, "", contextResolve(hook, skip));
      const result = await _callHook(hook.name, "failed to resolve", source, "", () =>
        hook.handler.call(context, source, importer, extra),
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

  const resolveId = (
    source: string,
    importer?: string,
    options?: PluginResolveIdCallOptions,
  ): Promise<PluginResolvedId | undefined> => _resolveId(source, importer, options, new Set(), []);

  const load = async (id: string, read?: () => string, options?: { resolved?: boolean }) => {
    const matchId = normalizeFilterId(id);
    let moduleType = moduleTypeOf(id);
    // Plugin ids (no `read`) have no fallback: every matching hook may load
    // them, whatever their extension.
    const required = read ? requiredMatch(moduleType) : undefined;
    const resolved = !read || options?.resolved;
    for (const hook of loadHooks) {
      if (!satisfiesMatch(hook.match(matchId, moduleType, undefined, resolved), required)) {
        continue;
      }
      const result = await _callHook(hook.name, "failed to load", id, "", () =>
        hook.handler.call(_createContext(hook.name, id, "", contextResolve(undefined, [])), id),
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
        resolved,
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
    if (!filter(id, undefined, resolved)) {
      return undefined;
    }
    return _transform(id, read(), moduleType, { resolved, changed: false });
  };

  // The `transform` hooks, from the code of `id`.
  const _transform = async (
    id: string,
    code: string,
    moduleType: PluginModuleType,
    // Maps aren't composed: the first map is kept, a second one would be
    // relative to already-mapped code, so both are dropped. Code-only steps
    // keep the current map (they should preserve lines).
    state: { resolved?: boolean; changed: boolean; map?: SourceMapLike; mappedBy?: string },
  ): Promise<PluginTransformOutput | undefined> => {
    let { changed, map, mappedBy } = state;
    const matchId = normalizeFilterId(id);
    for (const hook of transformHooks) {
      const match = hook.match(matchId, moduleType, code, state.resolved);
      if (!satisfiesMatch(match, requiredMatch(moduleType))) {
        continue;
      }
      const result = await _callHook(hook.name, "failed on", id, code, () =>
        hook.handler.call(
          _createContext(hook.name, id, code, contextResolve(undefined, [])),
          code,
          id,
          { moduleType },
        ),
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
      const file = stripQuery(id);
      const source = isAbsolute(file) ? pathToFileURL(file).href : file;
      const json = JSON.stringify({ ...map, sources: [source], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return { code, moduleType: moduleType as "js" | "ts" };
  };

  // Virtual modules, and modules the caller already sent here.
  const transform = (id: string, code: string, sourceType?: PluginModuleType) =>
    _transform(id, code, sourceType ?? moduleTypeOf(id), { resolved: true, changed: false });

  return {
    names: normalized.map((plugin) => plugin.name),
    prefilters,
    resolvePrefilters,
    filter,
    resolveFilter: (source, fallback) =>
      (fallback ? fallbackPrefilter : resolvePrefilter)(normalizeFilterId(source), "js", true),
    resolveId,
    load,
    transform,
  };
}

// `this.resolve()` without a plugin result: Node.js ESM resolution on the host.
function _resolveLikeRuntime(
  source: string,
  importer: string | undefined,
  conditions: string[] | undefined,
): PluginResolvedId | null {
  if (isBuiltin(source)) {
    return { id: source, external: true };
  }
  const from =
    importer && isAbsolute(stripQuery(importer)) ? stripQuery(importer) : `${process.cwd()}/`;
  const path = resolveModulePath(stripQuery(source), { from, conditions, try: true, cache: false });
  return path ? { id: path + queryOf(source), external: false } : null;
}

// Run a handler; errors name the plugin and id (`this.error()` messages
// already do), with the position (`id:line:column`) and code frame of
// errors with a `loc`, `pos` or `frame`, in `code`.
async function _callHook<T>(
  name: string,
  what: string,
  id: string,
  code: string,
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error: any) {
    const message = error?.message || String(error);
    if (message.startsWith("[env-runner]")) {
      throw error;
    }
    const at = `${id}${_formatPosition(code, _logPosition(error))}`;
    throw new Error(`[env-runner] plugin "${name}" ${what} "${at}": ${message}${_frame(error)}`, {
      cause: error,
    });
  }
}

// Position of a log or error: `loc` (1-based line, 0-based
// column), else a `pos` offset.
function _logPosition(log: unknown): PluginLogPosition | undefined {
  const { loc, pos } = (log ?? {}) as { loc?: { line?: unknown; column?: unknown }; pos?: unknown };
  if (typeof loc?.line === "number" && typeof loc.column === "number") {
    return { line: loc.line, column: loc.column };
  }
  return typeof pos === "number" ? pos : undefined;
}

// A log's code frame, on lines of its own.
function _frame(log: unknown): string {
  const frame = (log as { frame?: unknown } | null)?.frame;
  return typeof frame === "string" && frame.trim() ? `\n\n${frame.replace(/\n+$/, "")}` : "";
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
  const { name: pluginName, enforce } = plugin as Partial<EnvRunnerPlugin>;
  const name = typeof pluginName === "string" ? pluginName : `plugins${path}`;
  if (enforce != null && enforce !== "pre" && enforce !== "post") {
    return fail(`has an invalid \`enforce\` (${JSON.stringify(enforce)})`);
  }
  const normalized: NormalizedPlugin = { name, enforce: enforce ?? "normal" };
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
  let fallback = false;
  let handler: (...args: any[]) => unknown;
  if (typeof hook === "function") {
    handler = hook as typeof handler;
  } else if (hook && typeof hook === "object" && typeof (hook as any).handler === "function") {
    const object = hook as {
      order?: unknown;
      filter?: unknown;
      fallback?: unknown;
      handler: typeof handler;
    };
    if (object.order != null && object.order !== "pre" && object.order !== "post") {
      return fail(`has an invalid \`${kind}.order\` (${JSON.stringify(object.order)})`);
    }
    if (object.fallback != null && object.fallback !== false) {
      if (kind !== "resolveId") {
        return fail(`has a \`${kind}.fallback\` (only \`resolveId\` hooks take one)`);
      }
      if (object.fallback !== true) {
        return fail(`has an invalid \`${kind}.fallback\` (${_describe(object.fallback)})`);
      }
      fallback = true;
    }
    order = (object.order as "pre" | "post" | undefined) ?? "normal";
    filter = object.filter;
    handler = object.handler;
  } else {
    return fail(`has an invalid \`${kind}\` hook (got ${_describe(hook)})`);
  }
  // `load` filters can't name module types: a matching `id` include does.
  const load = kind === "load" ? { load: true as const } : {};
  // Sent with the prefilter: the worker asks only when resolving failed.
  const flags = { ...load, ...(fallback && { fallback: true as const }) };

  if (Array.isArray(filter)) {
    const expr = _normalizeExpressions(filter, kind, failFilter);
    const test = compileFilterExpressions(expr);
    const prefilter: SerializedPrefilter = { expr, ...flags };
    const level = compilePrefilter(prefilter);
    return {
      name,
      order,
      prefilter,
      fallback,
      // Without code (prefilter), a `code` expression may match.
      match: (id, moduleType, code, resolved) =>
        test(id, moduleType, code) !== false && level(id, moduleType, resolved, code),
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
  const prefilter: SerializedPrefilter = { id, moduleTypes, ...flags };
  const level = compilePrefilter(prefilter);
  return {
    name,
    order,
    prefilter,
    fallback,
    match: (idValue, moduleType, codeValue, resolved) =>
      (codeValue === undefined || !code || code.test(codeValue)) &&
      level(idValue, moduleType, resolved),
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
        pattern:
          value instanceof RegExp ? { source: value.source, flags: _statelessFlags(value) } : value,
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

function _createContext(
  name: string,
  id: string,
  code: string,
  resolve: PluginContext["resolve"],
): PluginContext {
  // A log object's own position (`loc`, `pos`) and `frame` count too.
  const format = (log: PluginLog, pos?: PluginLogPosition) =>
    typeof log === "string"
      ? `[env-runner] plugin "${name}" (${id}${_formatPosition(code, pos)}): ${log}`
      : `[env-runner] plugin "${name}" (${id}${_formatPosition(code, pos ?? _logPosition(log))}): ${log?.message}${_frame(log)}`;
  return {
    warn: (log, pos) => console.warn(format(log, pos)),
    info: (log, pos) => console.info(format(log, pos)),
    debug: () => {},
    error: (log, pos) => {
      throw new Error(format(log, pos), typeof log === "string" ? undefined : { cause: log });
    },
    resolve,
    addWatchFile: () => {},
    getWatchFiles: () => [],
    meta: { watchMode: false },
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
