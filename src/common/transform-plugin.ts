import * as nodePath from "node:path";

type MaybeArray<T> = T | T[];

/** Include values, or `{ include, exclude }` (exclude wins). */
export type TransformStringFilter =
  | MaybeArray<string | RegExp>
  | { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };

/** Module type of the code a handler receives (`js` once oxc ran). */
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

/** Must be sync (Node.js module hooks are). Return nullish to keep the code. */
export type TransformHandler = (
  code: string,
  id: string,
  meta: { moduleType: TransformModuleType },
) => TransformHandlerResult;

export type TransformHandlerResult =
  | string
  | { code?: string; map?: SourceMapLike | null }
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
 * Plugin object (only `transform` is used). `order: "pre"` runs
 * before oxc (on the TS/JSX source), otherwise after it; `"post"` last.
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

/**
 * Default export of a `transformers` module: a {@link TransformHandler} or a
 * {@link TransformPlugin}.
 */
export type SourceTransformer = TransformHandler | TransformPlugin;

/** A validated transformer, ready to run. */
export interface NormalizedTransformer {
  name: string;
  order: "pre" | "normal" | "post";
  /** Whether the handler runs for this code (`id` is `/`-separated). */
  matches(id: string, code: string, moduleType: TransformModuleType): boolean;
  handler: TransformHandler;
}

/** Validate a module's default export; throws a descriptive `TypeError`. */
export function normalizeTransformer(value: unknown, specifier: string): NormalizedTransformer {
  const fail = (reason: string): never => {
    throw new TypeError(
      `[env-runner] transformer "${specifier}" ${reason}: default-export a function ` +
        "`(code, id, meta) => string | { code, map } | undefined` or a " +
        "`{ name?, transform }` object (not a plugin factory).",
    );
  };
  if (typeof value === "function") {
    return {
      name: value.name || specifier,
      order: "normal",
      matches: () => true,
      handler: value as TransformHandler,
    };
  }
  if (!value || typeof value !== "object") {
    return fail("has no usable default export");
  }
  const plugin = value as Partial<TransformPlugin>;
  const name = typeof plugin.name === "string" ? plugin.name : specifier;
  const hook = plugin.transform;
  if (typeof hook === "function") {
    return { name, order: "normal", matches: () => true, handler: hook };
  }
  if (!hook || typeof hook !== "object" || typeof hook.handler !== "function") {
    return fail("is an object without a `transform` function or `transform.handler`");
  }
  if (hook.order != null && hook.order !== "pre" && hook.order !== "post") {
    return fail(`has an invalid \`transform.order\` (${JSON.stringify(hook.order)})`);
  }
  return {
    name,
    order: hook.order ?? "normal",
    matches: hook.filter ? _compileHookFilter(hook.filter) : () => true,
    handler: hook.handler,
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
