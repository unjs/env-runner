import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { resolveSpecifier } from "./runtime-deps.ts";
import { virtualModuleFormat } from "../virtual-loader.ts";
import { resolveTransformPlugin } from "./transform-plugin.ts";
import type {
  NormalizedTransformer,
  SourceMapLike,
  TransformModuleType,
} from "./transform-plugin.ts";

export type {
  SourceTransformer,
  TransformHandler,
  TransformHandlerMeta,
  TransformHandlerResult,
  TransformHookFilter,
  TransformModuleType,
  TransformPlugin,
  TransformPluginFactory,
  TransformStringFilter,
} from "./transform-plugin.ts";

/**
 * A transformer module specifier (resolved from cwd), optionally with
 * JSON-serializable options: `[specifier, options]`.
 */
export type TransformerEntry = string | URL | [specifier: string | URL, options?: unknown];

/**
 * Source transforms (TypeScript, JSX, ...) applied to the entry, its imports
 * and matching virtual modules. Passed as `data.transform`, so it must stay
 * JSON-serializable: transformers are module specifiers with options.
 */
export interface TransformOptions {
  /**
   * Transformer modules, whose default export is a {@link SourceTransformer}
   * (a plugin factory or a plugin object). Handlers run in this order within
   * their `order` group (`"pre"`, unordered, `"post"`). Built in:
   * `env-runner/transformers/oxc` (TypeScript/JSX with `oxc-transform`).
   */
  transformers: TransformerEntry[];

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
}

/** A RegExp as `{ source, flags }`, the form `include` crosses into the worker in. */
export interface SerializedRegExp {
  source: string;
  flags?: string;
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
  /** `include`/`exclude` only (no extension check), for formats known otherwise. */
  matchesPath(id: string): boolean;
  /**
   * Run the transformers on matched code: JavaScript, or `undefined` when none
   * changed it (serve it as if unmatched). Throws their errors, and when the
   * code changed but is still not JavaScript (no transformer returned
   * `moduleType: "js"`).
   */
  transform(id: string, code: string, moduleType?: TransformModuleType): string | undefined;
}

const DEFAULT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".jsx"];
const DEFAULT_EXCLUDE = ["/node_modules/"];

/**
 * Host side: validate `data.transform` and resolve its specifiers from cwd,
 * so the worker imports the app's copies.
 */
export function normalizeTransformOptions(
  opts: TransformOptions | undefined,
): TransformOptions | undefined {
  if (!opts) {
    return undefined;
  }
  if (!Array.isArray(opts.transformers)) {
    throw new TypeError("[env-runner] `transform.transformers` must be an array.");
  }
  const transformers = opts.transformers.map((entry, index): TransformerEntry => {
    const [specifier, options] = Array.isArray(entry) ? entry : [entry];
    if (typeof specifier !== "string" && !(specifier instanceof URL)) {
      throw new TypeError(
        `[env-runner] \`transform.transformers[${index}]\` must be a module specifier (string or URL) or \`[specifier, options]\`: ` +
          "transformers are imported inside the worker, so functions cannot be passed.",
      );
    }
    _assertSerializable(options, `transform.transformers[${index}] options`);
    const resolved = resolveSpecifier(specifier);
    return options === undefined ? resolved : [resolved, options];
  });
  return {
    ...opts,
    include: opts.include === undefined ? undefined : _serializeRegExp(opts.include),
    transformers,
  };
}

// Options cross into workers as JSON (process runners): only plain data
// round-trips (a RegExp or Date would arrive as `{}` or a string).
function _assertSerializable(value: unknown, path: string): void {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => _assertSerializable(item, `${path}[${index}]`));
    return;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `[env-runner] \`${path}\` must be JSON-serializable (plain objects, arrays and primitives): it is sent to the worker.`,
    );
  }
  for (const [key, item] of Object.entries(value as object)) {
    _assertSerializable(item, `${path}.${key}`);
  }
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

/** Load the pipeline (imports the transformers, calling plugin factories). */
export async function loadTransformer(
  opts: TransformOptions | undefined,
): Promise<Transformer | undefined> {
  if (!opts || !opts.transformers?.length) {
    return undefined;
  }
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const include = opts.include
    ? (({ source, flags }) => new RegExp(source, flags))(_serializeRegExp(opts.include))
    : undefined;
  const sourcemap = opts.sourcemap ?? true;

  const transformers: NormalizedTransformer[] = [];
  for (const entry of opts.transformers) {
    const [specifier, options] = Array.isArray(entry) ? entry : [entry];
    let mod: any;
    try {
      mod = await import(resolveSpecifier(specifier));
    } catch (error) {
      throw new TypeError(`[env-runner] failed to import transformer "${specifier}".`, {
        cause: error,
      });
    }
    transformers.push(await resolveTransformPlugin(mod?.default, String(specifier), options));
  }
  const byOrder = (order: NormalizedTransformer["order"]) =>
    transformers.filter((transformer) => transformer.order === order);
  const [pre, normal, post] = [byOrder("pre"), byOrder("normal"), byOrder("post")];

  const matchesPath = (id: string) => {
    const path = _stripQuery(id).replaceAll("\\", "/");
    return !exclude.some((part) => path.includes(part)) && (!include || include.test(path));
  };
  const filter = (id: string) => {
    const path = _stripQuery(id).replaceAll("\\", "/");
    return extensions.some((ext) => path.endsWith(ext)) && matchesPath(path);
  };

  const transform = (id: string, code: string, sourceType?: TransformModuleType) => {
    id = _stripQuery(id);
    const matchId = id.replaceAll("\\", "/");
    let moduleType = sourceType ?? _moduleType(id);
    // Maps aren't composed: the first map is kept, a second one would be
    // relative to already-mapped code, so both are dropped. Code-only steps
    // keep the current map (they should preserve lines).
    let map: SourceMapLike | null | undefined;
    let mapped = false;
    let changed = false;
    const apply = (next: string, nextMap: SourceMapLike | null | undefined) => {
      if (next === code) {
        return;
      }
      code = next;
      changed = true;
      if (nextMap) {
        map = mapped ? undefined : nextMap;
        mapped = true;
      }
    };
    const run = (group: NormalizedTransformer[]) => {
      for (const transformer of group) {
        if (!transformer.matches(matchId, code, moduleType)) {
          continue;
        }
        const result = transformer.handler(code, id, moduleType);
        if (typeof (result as any)?.then === "function") {
          throw new TypeError(
            `[env-runner] transformer "${transformer.name}" returned a Promise for "${id}"; transforms must be synchronous.`,
          );
        }
        if (typeof result === "string") {
          apply(result, undefined);
        } else if (result) {
          apply(result.code ?? code, result.map);
          moduleType = result.moduleType ?? moduleType;
        }
      }
    };

    run(pre);
    run(normal);
    run(post);

    if (!changed) {
      return undefined;
    }
    if (moduleType !== "js") {
      throw new TypeError(
        `[env-runner] "${id}" is still ${moduleType} after its transformers: add one that compiles it to JavaScript (returning \`moduleType: "js"\`, like \`env-runner/transformers/oxc\`) or narrow \`transform.extensions\`/\`include\`.`,
      );
    }
    if (sourcemap && map) {
      const source = isAbsolute(id) ? pathToFileURL(id).href : id;
      const json = JSON.stringify({ ...map, sources: [source], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return code;
  };

  return { extensions, include, exclude, filter, matchesPath, transform };
}

// `data.transform` source language of each virtual module code format.
const VIRTUAL_MODULE_TYPES: Partial<Record<string, TransformModuleType>> = {
  module: "js",
  commonjs: "js",
  "module-typescript": "ts",
  "commonjs-typescript": "ts",
  jsx: "jsx",
  tsx: "tsx",
};

/**
 * Transform a matching virtual module (resolved `data.virtual` entry) to plain
 * JS in its format's module system: virtual `.ts`/`.tsx` stay ESM, like
 * untransformed ones. A key without a matching extension qualifies by a
 * TypeScript/JSX format (the initial `moduleType`). Others are returned as is.
 */
export function transformVirtualModule<
  T extends string | { source: string | Uint8Array; format: string },
>(
  transformer: Transformer,
  key: string,
  module: T,
): T | { source: string; format: "module" | "commonjs" } {
  const format = virtualModuleFormat(key, module as any);
  const moduleType = VIRTUAL_MODULE_TYPES[format];
  if (
    !moduleType ||
    !transformer.matchesPath(key) ||
    !(moduleType !== "js" || transformer.filter(key))
  ) {
    return module;
  }
  const source = typeof module === "string" ? module : (module.source as string);
  const code = transformer.transform(key, source, moduleType);
  if (code === undefined) {
    return module;
  }
  return { source: code, format: format.startsWith("commonjs") ? "commonjs" : "module" };
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
            const format =
              source === undefined ? undefined : transformedFormat(path, source, context.format);
            if (format && !(isDeno && format === "commonjs")) {
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
          const code = _active === transformer ? transformer.transform(path, contents) : undefined;
          // `onLoad` can't decline: untouched code goes to Bun's native loader.
          return code === undefined
            ? { contents, loader: _bunLoader(path) }
            : { contents: code, loader: "js" };
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

// Bun's native loader, for untouched code and loads after unregistering.
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

// Initial module type, from the extension.
function _moduleType(id: string): TransformModuleType {
  const ext = id.slice(id.lastIndexOf(".") + 1);
  if (ext === "tsx" || ext === "jsx") {
    return ext;
  }
  return /^[cm]?ts$/.test(ext) ? "ts" : "js";
}

function _stripQuery(id: string): string {
  const qIndex = id.indexOf("?");
  return qIndex === -1 ? id : id.slice(0, qIndex);
}

const _noop = () => {};
