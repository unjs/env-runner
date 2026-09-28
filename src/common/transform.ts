import type {
  TransformOptions as OxcTransformOptions,
  TransformResult as OxcTransformResult,
} from "oxc-transform";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDep, resolveSpecifier } from "./runtime-deps.ts";

export type { OxcTransformOptions };

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

/**
 * Custom transform, the default export of a `transformers` module. Must be
 * sync (Node.js module hooks are). Return nullish to keep the code; return a
 * `map` when the change shifts lines (it replaces the previous one).
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
    transformers,
    oxcTransform: opts.oxcTransform ? resolveSpecifier(opts.oxcTransform) : undefined,
  };
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
  const sourcemap = opts.sourcemap ?? true;

  let oxcTransform: ((id: string, code: string) => OxcTransformResult) | undefined;
  if (opts.oxc !== false) {
    const oxc = await resolveRuntimeDep<typeof import("oxc-transform")>({
      name: "oxc-transform",
      option: "transform.oxcTransform",
      value: opts.oxcTransform,
      expect: "transformSync",
      required: true,
      hint: "Or set `transform.oxc: false` to only run custom `transformers`.",
    });
    const oxcOptions: OxcTransformOptions = {
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
      extensions.some((ext) => path.endsWith(ext)) && !exclude.some((part) => path.includes(part))
    );
  };

  const transform = (id: string, code: string) => {
    id = _stripQuery(id);
    let map: SourceMapLike | null | undefined;
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
    }
    for (const transformer of transformers) {
      const result = transformer(code, id);
      if (typeof result === "string") {
        code = result;
      } else if (result) {
        code = result.code;
        map = result.map ?? map;
      }
    }
    if (sourcemap && map) {
      const json = JSON.stringify({ ...map, sources: [id], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return code;
  };

  return { extensions, filter, transform };
}

let _active: Transformer | undefined;

/** Transformer registered in this worker (used by entry reloads). */
export function getActiveTransformer(): Transformer | undefined {
  return _active;
}

/**
 * Transform matching disk modules in this worker; await before importing the
 * entry. Node.js/Deno: a `module.registerHooks` load hook. Bun: `Bun.plugin`
 * `onLoad` (can't be removed). Warns once and skips elsewhere.
 */
export async function registerTransformHooks(transformer?: Transformer): Promise<() => void> {
  if (!transformer) {
    return _noop;
  }
  _active = transformer;
  const { registerHooks } = await import("node:module");
  if (typeof registerHooks === "function") {
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith("file:") && transformer.filter(url)) {
          const path = fileURLToPath(_stripQuery(url));
          // Keep CommonJS where resolution detected it (`.cts`, `"type": "commonjs"`).
          const format =
            context.format?.startsWith("commonjs") || path.endsWith(".cts") ? "commonjs" : "module";
          return {
            format,
            source: transformer.transform(path, readFileSync(path, "utf8")),
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      },
    });
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
        const filter = new RegExp(
          `(?:${transformer.extensions.map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
        );
        build.onLoad({ filter }, ({ path }: { path: string }) => {
          const contents = readFileSync(path, "utf8");
          if (_active === transformer && transformer.filter(path)) {
            return { contents: transformer.transform(path, contents), loader: "js" };
          }
          return { contents, loader: _bunLoader(path) };
        });
      },
    });
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

// Bun's native loader for excluded paths (e.g. `node_modules`) matching an extension.
function _bunLoader(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts": {
      return "ts";
    }
    case "tsx":
    case "jsx":
    case "json":
    case "toml": {
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
