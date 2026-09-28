import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { resolveRuntimeDep, resolveSpecifier } from "./runtime-deps.ts";

/**
 * [`oxc-transform`](https://oxc.rs/docs/guide/usage/transformer)
 * `TransformOptions`, declared structurally so `env-runner` types don't depend
 * on the package: nested groups are loosely typed, so an object typed with
 * `oxc-transform`'s own `TransformOptions` is assignable. `sourcemap` follows
 * {@link TransformOptions.sourcemap}.
 */
export interface OxcTransformOptions {
  lang?: "js" | "jsx" | "ts" | "tsx" | "dts";
  sourceType?: "script" | "module" | "commonjs" | "unambiguous";
  cwd?: string;
  assumptions?: object;
  typescript?: object;
  decorator?: object;
  plugins?: object;
  jsx?: "preserve" | OxcJsxOptions;
  target?: string | string[];
  helpers?: object;
  inject?: Record<string, string | [string, string]>;
  define?: Record<string, string>;
}

/** `oxc-transform` `JsxOptions`. */
export interface OxcJsxOptions {
  runtime?: "classic" | "automatic";
  development?: boolean;
  throwIfNamespace?: boolean;
  pure?: boolean;
  importSource?: string;
  pragma?: string;
  pragmaFrag?: string;
  refresh?: boolean | object;
}

interface OxcTransformResult {
  code: string;
  map?: SourceMapLike;
  errors: { severity: string; message: string; codeframe: string | null }[];
}

interface OxcTransformModule {
  transformSync(filename: string, code: string, options?: object): OxcTransformResult;
}

/**
 * Source transforms (TypeScript, JSX, ...) applied to the entry, its imports
 * and matching virtual modules. Passed as `data.transform`, so it must stay
 * JSON-serializable: custom transforms are module specifiers.
 */
export interface TransformOptions {
  /**
   * [`oxc-transform`](https://oxc.rs/docs/guide/usage/transformer) options
   * (`true` for defaults), or `false` to only run `transformers`.
   * @default true
   */
  oxc?: OxcTransformOptions | boolean;

  /**
   * Module specifiers (resolved from cwd) whose default export is a sync
   * {@link SourceTransformer}. They run after oxc, in order, on plain JS.
   */
  transformers?: (string | URL)[];

  /**
   * File extensions to transform.
   * @default [".ts", ".mts", ".cts", ".tsx", ".jsx"]
   */
  extensions?: string[];

  /**
   * Only transform paths (`/`-separated) and virtual keys matching this
   * RegExp, on top of `extensions` and `exclude`. Sent to the worker as
   * `{ source, flags }` (the `g`/`y` flags are dropped).
   */
  include?: RegExp | SerializedRegExp;

  /**
   * Skip paths containing any of these substrings (`/`-separated).
   * @default ["/node_modules/"]
   */
  exclude?: string[];

  /**
   * Append inline source maps (stack traces need `--enable-source-maps`).
   * @default true
   */
  sourcemap?: boolean;

  /**
   * The `oxc-transform` package specifier (resolved from cwd). Omitted:
   * imported from the app.
   */
  oxcTransform?: string | URL;
}

/** A RegExp as `{ source, flags }`, the form `include` crosses into the worker in. */
export interface SerializedRegExp {
  source: string;
  flags?: string;
}

/**
 * Custom transform, the default export of a `transformers` module. Must be
 * sync (Node.js module hooks are). Return nullish to keep the code. A returned
 * `map` is only used when no earlier step (oxc included) changed the code, as
 * maps aren't composed; code-only results keep the previous map (so they
 * should preserve lines).
 */
export type SourceTransformer = (
  code: string,
  id: string,
) => string | { code: string; map?: SourceMapLike | null } | null | undefined;

interface SourceMapLike {
  version?: number;
  mappings: string;
  names?: string[];
  sources?: string[];
  sourcesContent?: (string | null)[];
}

/** A loaded {@link TransformOptions} pipeline. */
export interface Transformer {
  /** Transformed file extensions. */
  extensions: string[];
  /** Included paths (tested `/`-separated), if restricted. */
  include?: RegExp;
  /** Excluded path substrings (`/`-separated). */
  exclude: string[];
  /** Whether a path (or virtual key) is transformed. Queries are ignored. */
  filter(id: string): boolean;
  /** Transform matched code to JS; throws on oxc errors. */
  transform(id: string, code: string): string;
}

const DEFAULT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".jsx"];
const DEFAULT_EXCLUDE = ["/node_modules/"];

/**
 * Host side: validate `data.transform` and resolve its specifiers from cwd,
 * so the worker imports the app's copies.
 */
export function normalizeTransformOptions(
  opts: TransformOptions | boolean | undefined,
): TransformOptions | undefined {
  if (!opts) {
    return undefined;
  }
  if (opts === true) {
    return {};
  }
  const transformers = opts.transformers?.map((transformer) => {
    if (typeof transformer !== "string" && !(transformer instanceof URL)) {
      throw new TypeError(
        "[env-runner] `transform.transformers` entries must be module specifiers (string or URL): " +
          "they are imported inside the worker, so functions cannot be passed.",
      );
    }
    return resolveSpecifier(transformer);
  });
  return {
    ...opts,
    include: opts.include === undefined ? undefined : _serializeRegExp(opts.include),
    transformers,
    oxcTransform: opts.oxcTransform ? resolveSpecifier(opts.oxcTransform) : undefined,
  };
}

// Neither JSON nor `workerData` round-trips a RegExp uniformly: send its parts.
// Stateful flags (`g`/`y`) would make `test()` depend on `lastIndex`.
function _serializeRegExp(value: RegExp | SerializedRegExp): SerializedRegExp {
  if (!(value instanceof RegExp) && typeof value?.source !== "string") {
    throw new TypeError("[env-runner] `transform.include` must be a RegExp.");
  }
  const { source, flags = "" } = value;
  // Validates `{ source, flags }` input too.
  return { source, flags: new RegExp(source, flags.replace(/[gy]/g, "")).flags };
}

/** Load the pipeline (imports `oxc-transform` and custom transformers). */
export async function loadTransformer(
  opts: TransformOptions | boolean | undefined,
): Promise<Transformer | undefined> {
  if (!opts) {
    return undefined;
  }
  if (opts === true) {
    opts = {};
  }
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const include = opts.include
    ? (({ source, flags }) => new RegExp(source, flags))(_serializeRegExp(opts.include))
    : undefined;
  const sourcemap = opts.sourcemap ?? true;

  let oxcTransform: ((id: string, code: string) => OxcTransformResult) | undefined;
  if (opts.oxc !== false) {
    const oxc = await resolveRuntimeDep<OxcTransformModule>({
      name: "oxc-transform",
      option: "transform.oxcTransform",
      value: opts.oxcTransform,
      expect: "transformSync",
      required: true,
      hint: "Or set `transform.oxc: false` to only run custom `transformers`.",
    });
    const oxcOptions = {
      ...(typeof opts.oxc === "object" ? opts.oxc : undefined),
      sourcemap,
    };
    oxcTransform = (id, code) => oxc!.transformSync(id, code, oxcOptions);
  }

  const transformers: SourceTransformer[] = [];
  for (const specifier of opts.transformers ?? []) {
    let mod: any;
    try {
      mod = await import(resolveSpecifier(specifier));
    } catch (error) {
      throw new TypeError(`[env-runner] failed to import transformer "${specifier}".`, {
        cause: error,
      });
    }
    const fn = mod?.default;
    if (typeof fn !== "function") {
      throw new TypeError(
        `[env-runner] transformer "${specifier}" must default-export a function \`(code, id) => string | { code, map } | undefined\`.`,
      );
    }
    transformers.push(fn);
  }

  const filter = (id: string) => {
    const path = _stripQuery(id).replaceAll("\\", "/");
    return (
      extensions.some((ext) => path.endsWith(ext)) &&
      !exclude.some((part) => path.includes(part)) &&
      (!include || include.test(path))
    );
  };

  const transform = (id: string, code: string) => {
    id = _stripQuery(id);
    let map: SourceMapLike | null | undefined;
    let changed = false;
    if (oxcTransform) {
      const result = oxcTransform(id, code);
      const errors = result.errors.filter((error) => error.severity === "Error");
      if (errors.length > 0) {
        throw new SyntaxError(
          `[env-runner] failed to transform "${id}":\n` +
            errors.map((error) => error.codeframe || error.message).join("\n"),
        );
      }
      code = result.code;
      map = result.map;
      changed = true;
    }
    for (const transformer of transformers) {
      const result = transformer(code, id);
      if (typeof result === "string") {
        code = result;
      } else if (result) {
        code = result.code;
        // A map is relative to this transformer's input: only valid when that
        // input is the original source (no composition). Else drop it.
        map = result.map ? (changed ? undefined : result.map) : map;
      } else {
        continue;
      }
      changed = true;
    }
    if (sourcemap && map) {
      const source = isAbsolute(id) ? pathToFileURL(id).href : id;
      const json = JSON.stringify({ ...map, sources: [source], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return code;
  };

  return { extensions, include, exclude, filter, transform };
}

let _active: Transformer | undefined;

/** Transformer registered in this worker (used by entry reloads). */
export function getActiveTransformer(): Transformer | undefined {
  return _active;
}

const CJS_MARKERS = /\b(?:module\.exports\b|exports\.\w|require\s*\()/;

/**
 * Module format of transformed code: the resolution hint when definite, then
 * the extension, then syntax. Node's hint is missing for `.tsx`/`.jsx` and in
 * packages without `"type"`, so CommonJS needs CommonJS markers and no ESM
 * syntax (a marker-free file, e.g. only top-level `await`, stays ESM).
 */
export function transformedFormat(
  path: string,
  code: string,
  hint?: string | null,
): "module" | "commonjs" {
  if (hint?.startsWith("module")) {
    return "module";
  }
  if (hint?.startsWith("commonjs")) {
    return "commonjs";
  }
  if (/\.m[jt]sx?$/.test(path)) {
    return "module";
  }
  if (/\.c[jt]sx?$/.test(path)) {
    return "commonjs";
  }
  if (!CJS_MARKERS.test(code)) {
    return "module";
  }
  try {
    return parseEsm(code)[3] ? "module" : "commonjs";
  } catch {
    return "module";
  }
}

/**
 * Transform matching disk modules in this worker; await before importing the
 * entry. Warns once and skips on runtimes without either backend:
 *
 * - Node.js/Deno: a `module.registerHooks` load hook. Deno evaluates hook
 *   output as ESM, so CommonJS files fall back to its native loader.
 * - Bun: a `Bun.plugin` `onLoad` (can't be removed). Its output is always
 *   evaluated as ESM, so `exclude`d paths and `.cts`/`.cjs` never reach it.
 */
export async function registerTransformHooks(transformer?: Transformer): Promise<() => void> {
  if (!transformer) {
    return _noop;
  }
  await initEsmLexer();
  const { registerHooks } = await import("node:module");
  if (typeof registerHooks === "function") {
    const isDeno = "Deno" in globalThis;
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith("file:")) {
          const path = fileURLToPath(_stripQuery(url));
          if (transformer.filter(path)) {
            const source = transformer.transform(path, readFileSync(path, "utf8"));
            const format = transformedFormat(path, source, context.format);
            if (!(isDeno && format === "commonjs")) {
              return { format, source, shortCircuit: true };
            }
          }
        }
        return nextLoad(url, context);
      },
    });
    _active = transformer;
    return () => {
      if (_active === transformer) {
        _active = undefined;
      }
      hooks.deregister();
    };
  }
  const bunPlugin = (globalThis as any).Bun?.plugin;
  if (typeof bunPlugin === "function") {
    bunPlugin({
      name: "env-runner-transform",
      setup(build: any) {
        build.onLoad({ filter: _bunFilter(transformer) }, ({ path }: { path: string }) => {
          const contents = readFileSync(path, "utf8");
          return {
            contents: _active === transformer ? transformer.transform(path, contents) : contents,
            loader: _active === transformer ? "js" : _bunLoader(path),
          };
        });
      },
    });
    _active = transformer;
    return () => {
      if (_active === transformer) {
        _active = undefined;
      }
    };
  }
  console.warn(
    "[env-runner] `transform` requires `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.x) or `Bun.plugin`; skipping.",
  );
  return _noop;
}

/**
 * One RegExp (Bun's only filter): extensions minus CommonJS ones, `exclude` as
 * a negative lookahead (either separator), `include` as a lookahead. It takes
 * `include`'s flags, so the other parts stay valid in `u`/`v` mode. Bun paths
 * keep native separators: on Windows, `include` must match `\\` too.
 */
function _bunFilter(transformer: Transformer): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const extensions = transformer.extensions
    .filter((ext) => !/^\.c[jt]sx?$/.test(ext))
    .map((ext) => escape(ext));
  const exclude = transformer.exclude.map((part) =>
    escape(part).replaceAll("/", String.raw`(?:\\|\/)`),
  );
  const { include } = transformer;
  const lookaheads =
    (exclude.length > 0 ? `(?!.*(?:${exclude.join("|")}))` : "") +
    (include ? `(?=.*?(?:${include.source}))` : "");
  return new RegExp(`^${lookaheads}.*(?:${extensions.join("|") || "(?!)"})$`, include?.flags);
}

// Bun's native loader, for loads after the transformer is unregistered.
function _bunLoader(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  switch (ext) {
    case "ts":
    case "mts": {
      return "ts";
    }
    case "tsx":
    case "jsx": {
      return ext;
    }
    default: {
      return "js";
    }
  }
}

function _stripQuery(id: string): string {
  const qIndex = id.indexOf("?");
  return qIndex === -1 ? id : id.slice(0, qIndex);
}

const _noop = () => {};
