import * as nodePath from "node:path";

type MaybeArray<T> = T | T[];

/** Include values, or `{ include, exclude }` (exclude wins). */
export type TransformStringFilter =
  | MaybeArray<string | RegExp>
  | { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };

/** Module type of the code a handler receives (`js` once a transformer returned JS). */
export type TransformModuleType = "js" | "jsx" | "ts" | "tsx" | (string & {});

/**
 * `transform` hook filter (all given properties must match).
 * - `id`: strings are globs (`path.matchesGlob`; relative ones resolve from
 *   cwd), RegExps are tested; both against the `/`-separated id.
 * - `code`: strings are substrings, RegExps are tested.
 * - `moduleType`: see {@link TransformModuleType}.
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
  /** The options of this transformer's `transformers` entry. */
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
 * Plugin object (only `transform` is used). Handlers run in `transformers`
 * order within their `order` group: `"pre"`, then unordered, then `"post"`.
 */
export interface TransformPlugin {
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
export type TransformPluginFactory = (options: any) => TransformPlugin | Promise<TransformPlugin>;

/**
 * Default export of a `transformers` module: a {@link TransformPluginFactory}
 * (called with the entry's options) or a {@link TransformPlugin} (its handler
 * gets them as `meta.options`).
 */
export type SourceTransformer = TransformPlugin | TransformPluginFactory;

/** A validated transformer, ready to run. */
export interface NormalizedTransformer {
  name: string;
  order: "pre" | "normal" | "post";
  /** Whether the handler runs for this code (`id` is `/`-separated). */
  matches(id: string, code: string, moduleType: TransformModuleType): boolean;
  handler(code: string, id: string, moduleType: TransformModuleType): TransformHandlerResult;
}

/**
 * Resolve a module's default export (calling a factory with `options`) and
 * validate it; throws a descriptive `TypeError`.
 */
export async function resolveTransformPlugin(
  value: unknown,
  specifier: string,
  options: unknown,
): Promise<NormalizedTransformer> {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] transformer "${specifier}" ${reason}: default-export a plugin factory ` +
        "`(options) => ({ name?, transform })` or a `{ name?, transform }` plugin object.",
    );
  };
  let plugin = value;
  if (typeof value === "function") {
    try {
      plugin = await value(options);
    } catch (error: any) {
      throw new TypeError(
        `[env-runner] transformer "${specifier}" failed to initialize: ${error?.message || error}`,
        { cause: error },
      );
    }
    if (!plugin || typeof plugin !== "object") {
      return fail("has a factory that didn't return a plugin object");
    }
  } else if (!plugin || typeof plugin !== "object") {
    return fail("has no usable default export");
  }
  const { name: pluginName, transform: hook } = plugin as Partial<TransformPlugin>;
  const name = typeof pluginName === "string" ? pluginName : specifier;
  let order: NormalizedTransformer["order"] = "normal";
  let matches: NormalizedTransformer["matches"] = () => true;
  let handler: TransformHandler;
  if (typeof hook === "function") {
    handler = hook;
  } else if (hook && typeof hook === "object" && typeof hook.handler === "function") {
    if (hook.order != null && hook.order !== "pre" && hook.order !== "post") {
      return fail(`has an invalid \`transform.order\` (${JSON.stringify(hook.order)})`);
    }
    order = hook.order ?? "normal";
    matches = hook.filter ? _compileHookFilter(hook.filter) : matches;
    handler = hook.handler;
  } else {
    return fail("has no `transform` function or `transform.handler`");
  }
  return {
    name,
    order,
    matches,
    handler: (code, id, moduleType) => handler.call(undefined, code, id, { moduleType, options }),
  };
}

function _compileHookFilter(filter: TransformHookFilter): NormalizedTransformer["matches"] {
  const id = filter.id === undefined ? undefined : _compileStringFilter(filter.id, _matchId);
  const code =
    filter.code === undefined ? undefined : _compileStringFilter(filter.code, _matchCode);
  const moduleTypes = Array.isArray(filter.moduleType)
    ? filter.moduleType
    : filter.moduleType?.include;
  return (idValue, codeValue, moduleType) =>
    (!id || id(idValue)) &&
    (!moduleTypes || moduleTypes.includes(moduleType)) &&
    (!code || code(codeValue));
}

function _compileStringFilter(
  filter: TransformStringFilter,
  match: (pattern: string | RegExp, value: string) => boolean,
): (value: string) => boolean {
  const formal =
    filter && typeof filter === "object" && !Array.isArray(filter) && !(filter instanceof RegExp);
  const toList = (value: MaybeArray<string | RegExp> | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const include = formal ? toList(filter.include) : toList(filter as MaybeArray<string | RegExp>);
  const exclude = formal ? toList(filter.exclude) : [];
  return (value) =>
    !exclude.some((pattern) => match(pattern, value)) &&
    (include.length === 0 || include.some((pattern) => match(pattern, value)));
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
