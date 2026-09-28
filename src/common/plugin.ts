import * as nodePath from "node:path";

type MaybeArray<T> = T | T[];

/** Include values, or `{ include, exclude }` (exclude wins). */
export type TransformStringFilter =
  | MaybeArray<string | RegExp>
  | { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };

/** Module type of the code a handler receives (`js` once a plugin returned JS). */
export type TransformModuleType = "js" | "jsx" | "ts" | "tsx" | (string & {});

/**
 * `transform` hook filter (all given properties must match).
 * - `id`: strings are globs (`path.matchesGlob`; relative ones resolve from
 *   cwd), RegExps are tested; both against the `/`-separated id.
 * - `code`: strings are substrings, RegExps are tested.
 * - `moduleType`: see {@link TransformModuleType}.
 *
 * `id` and `moduleType` also decide which modules are read and run through
 * the plugins at all: a module no plugin's `id`/`moduleType` filter matches
 * (with its initial module type) is left to the runtime.
 */
export interface TransformHookFilter {
  id?: TransformStringFilter;
  code?: TransformStringFilter;
  moduleType?: TransformModuleType[] | { include?: TransformModuleType[] };
}

/** Passed to every handler. */
export interface TransformHandlerMeta {
  /** Language of `code` (updated by results returning a `moduleType`). */
  moduleType: TransformModuleType;
  /** The options of this plugin's `plugins` entry. */
  options: unknown;
}

/** Must be sync (Node.js module hooks are). Return nullish to keep the code. */
export type TransformHandler = (
  code: string,
  id: string,
  meta: TransformHandlerMeta,
) => TransformHandlerResult;

/**
 * New code, or `{ code, map, moduleType }`: a `moduleType` tells later
 * handlers the new language (e.g. `js` after compiling TypeScript).
 */
export type TransformHandlerResult =
  | string
  | { code?: string; map?: SourceMapLike | null; moduleType?: TransformModuleType }
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
 * Plugin object (only the `transform` hook is used; others are ignored with a
 * warning). Handlers run in `plugins` order within their `order` group:
 * `"pre"`, then unordered, then `"post"`.
 */
export interface EnvRunnerPlugin {
  name?: string;
  transform:
    | TransformHandler
    | {
        order?: "pre" | "post" | null;
        filter?: TransformHookFilter;
        handler: TransformHandler;
      };
}

/** Called once per worker with the entry's options. May be async. */
export type EnvRunnerPluginFactory = (options: any) => EnvRunnerPlugin | Promise<EnvRunnerPlugin>;

/** A validated plugin, ready to run. */
export interface NormalizedPlugin {
  name: string;
  order: "pre" | "normal" | "post";
  /** `filter.id` patterns (`undefined` without an `id` filter; no includes = all). */
  id?: { include: (string | RegExp)[]; exclude: (string | RegExp)[] };
  /** `filter.moduleType` (`undefined` without one). */
  moduleTypes?: TransformModuleType[];
  /**
   * Whether a module can reach this plugin: its `id` and `moduleType` filters
   * (`id` is `/`-separated, `moduleType` the initial one).
   */
  prefilter(id: string, moduleType: TransformModuleType): boolean;
  /** Whether the handler runs for this code (`id` is `/`-separated). */
  matches(id: string, code: string, moduleType: TransformModuleType): boolean;
  handler(code: string, id: string, moduleType: TransformModuleType): TransformHandlerResult;
}

const _warnedHooks = new Set<string>();

/**
 * Resolve a module's default export (calling a factory with `options`) and
 * validate it; throws a descriptive `TypeError`.
 */
export async function resolvePlugin(
  value: unknown,
  specifier: string,
  options: unknown,
): Promise<NormalizedPlugin> {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] plugin "${specifier}" ${reason}: default-export a plugin factory ` +
        "`(options) => ({ name?, transform })` or a `{ name?, transform }` plugin object.",
    );
  };
  let plugin = value;
  if (typeof value === "function") {
    try {
      plugin = await value(options);
    } catch (error: any) {
      throw new TypeError(
        `[env-runner] plugin "${specifier}" failed to initialize: ${error?.message || error}`,
        { cause: error },
      );
    }
    if (!plugin || typeof plugin !== "object") {
      return fail("has a factory that didn't return a plugin object");
    }
  } else if (!plugin || typeof plugin !== "object") {
    return fail("has no usable default export");
  }
  const { name: pluginName, transform: hook } = plugin as Partial<EnvRunnerPlugin>;
  const name = typeof pluginName === "string" ? pluginName : specifier;
  let order: NormalizedPlugin["order"] = "normal";
  let filter: TransformHookFilter | undefined;
  let handler: TransformHandler;
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
  _warnUnsupportedHooks(name, plugin as Record<string, unknown>);

  const id = filter?.id === undefined ? undefined : _compileStringFilter(filter.id, _matchId);
  const code =
    filter?.code === undefined ? undefined : _compileStringFilter(filter.code, _matchCode);
  const moduleTypes = Array.isArray(filter?.moduleType)
    ? filter.moduleType
    : filter?.moduleType?.include;
  const prefilter = (idValue: string, moduleType: TransformModuleType) =>
    (!id || id.test(idValue)) && (!moduleTypes || moduleTypes.includes(moduleType));
  return {
    name,
    order,
    id: id && { include: id.include, exclude: id.exclude },
    moduleTypes,
    prefilter,
    matches: (idValue, codeValue, moduleType) =>
      prefilter(idValue, moduleType) && (!code || code.test(codeValue)),
    handler: (codeValue, idValue, moduleType) =>
      handler.call(undefined, codeValue, idValue, { moduleType, options }),
  };
}

// Only `transform` runs: say so once per plugin when it has other hooks.
function _warnUnsupportedHooks(name: string, plugin: Record<string, unknown>): void {
  const ignored = Object.keys(plugin).filter((key) => {
    const value = plugin[key];
    return (
      key !== "transform" &&
      (typeof value === "function" ||
        (!!value && typeof value === "object" && typeof (value as any).handler === "function"))
    );
  });
  if (ignored.length > 0 && !_warnedHooks.has(name)) {
    _warnedHooks.add(name);
    console.warn(
      `[env-runner] plugin "${name}": only the \`transform\` hook is supported; ignoring ${ignored.map((key) => `\`${key}\``).join(", ")}.`,
    );
  }
}

function _compileStringFilter(
  filter: TransformStringFilter,
  match: (pattern: string | RegExp, value: string) => boolean,
): {
  include: (string | RegExp)[];
  exclude: (string | RegExp)[];
  test: (value: string) => boolean;
} {
  const formal =
    filter && typeof filter === "object" && !Array.isArray(filter) && !(filter instanceof RegExp);
  const toList = (value: MaybeArray<string | RegExp> | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const include = formal ? toList(filter.include) : toList(filter as MaybeArray<string | RegExp>);
  const exclude = formal ? toList(filter.exclude) : [];
  return {
    include,
    exclude,
    test: (value) =>
      !exclude.some((pattern) => match(pattern, value)) &&
      (include.length === 0 || include.some((pattern) => match(pattern, value))),
  };
}

function _matchId(pattern: string | RegExp, id: string): boolean {
  if (typeof pattern !== "string") {
    return _testRegExp(pattern, id);
  }
  // Namespace access: a named import fails to link before Node.js 22.5.
  if (typeof nodePath.matchesGlob !== "function") {
    throw new TypeError(
      "[env-runner] glob `id` filters need `path.matchesGlob` (Node.js >= 22.5); use a RegExp instead.",
    );
  }
  // Relative globs resolve from cwd.
  const glob =
    nodePath.isAbsolute(pattern) || pattern.startsWith("*")
      ? pattern
      : nodePath.join(process.cwd(), pattern).replaceAll("\\", "/");
  return nodePath.matchesGlob(id, glob);
}

function _matchCode(pattern: string | RegExp, code: string): boolean {
  return typeof pattern === "string" ? code.includes(pattern) : _testRegExp(pattern, code);
}

// `g`/`y` RegExps are stateful through `lastIndex`.
function _testRegExp(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
