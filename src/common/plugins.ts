import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { resolveSpecifier } from "./runtime-deps.ts";
import { virtualModuleFormat } from "../virtual-loader.ts";
import { resolvePlugin } from "./plugin.ts";
import type { NormalizedPlugin, SourceMapLike, PluginModuleType } from "./plugin.ts";

export type {
  EnvRunnerPlugin,
  EnvRunnerPluginFactory,
  PluginContext,
  PluginModuleType,
  PluginStringFilter,
  PluginTransformFilter,
  PluginTransformHandler,
  PluginTransformMeta,
  PluginTransformResult,
} from "./plugin.ts";

/**
 * A plugin module specifier (resolved from cwd), optionally with
 * JSON-serializable options: `[specifier, options]`. The module
 * default-exports an {@link EnvRunnerPluginFactory} (called with the options)
 * or an {@link EnvRunnerPlugin} (its handler gets them as `meta.options`).
 */
export type EnvRunnerPluginEntry = string | URL | [specifier: string | URL, options?: unknown];

/** A loaded `data.plugins` pipeline. */
export interface PluginPipeline {
  plugins: NormalizedPlugin[];
  /**
   * Whether a module goes through the plugins: not under `/node_modules/`, and
   * some plugin's `id`/`moduleType` filter matches. Without `moduleType`, `id`
   * is a file that also needs a script extension (its initial module type).
   * Queries are ignored.
   */
  filter(id: string, moduleType?: PluginModuleType): boolean;
  /**
   * Run the plugins on matched code: JavaScript, or `undefined` when none
   * changed it (serve it as if unmatched). Throws their errors, and when the
   * code changed but is still not JavaScript (no plugin returned
   * `moduleType: "js"`).
   */
  transform(id: string, code: string, moduleType?: PluginModuleType): string | undefined;
}

/** File extensions of modules plugins can transform. */
export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"];

/**
 * Host side: validate `data.plugins` and resolve its specifiers from cwd, so
 * the worker imports the app's copies.
 */
export function normalizePluginEntries(
  entries: EnvRunnerPluginEntry[] | undefined,
): EnvRunnerPluginEntry[] | undefined {
  if (entries === undefined) {
    return undefined;
  }
  if (!Array.isArray(entries)) {
    throw new TypeError("[env-runner] `data.plugins` must be an array.");
  }
  return entries.map((entry, index): EnvRunnerPluginEntry => {
    const [specifier, options] = Array.isArray(entry) ? entry : [entry];
    if (typeof specifier !== "string" && !(specifier instanceof URL)) {
      throw new TypeError(
        `[env-runner] \`data.plugins[${index}]\` must be a module specifier (string or URL) or \`[specifier, options]\`: ` +
          "`data.plugins` takes plugin modules, loaded inside the worker, so functions and objects cannot be passed. " +
          "srvx server plugins belong on the app entry's `plugins` (`export default { fetch, plugins }`).",
      );
    }
    _assertSerializable(options, `plugins[${index}] options`);
    const resolved = resolveSpecifier(specifier);
    // A path that doesn't resolve here won't in the worker either (same cwd):
    // fail with the path instead of an import error from inside the worker.
    if (resolved === specifier && (/^\.\.?(?:[/\\]|$)/.test(specifier) || isAbsolute(specifier))) {
      throw new TypeError(
        `[env-runner] \`data.plugins[${index}]\` "${specifier}" does not resolve from ${process.cwd()}.`,
      );
    }
    return options === undefined ? resolved : [resolved, options];
  });
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

/** Load the pipeline (imports the plugins, calling plugin factories). */
export async function loadPlugins(
  entries: EnvRunnerPluginEntry[] | undefined,
): Promise<PluginPipeline | undefined> {
  if (!entries?.length) {
    return undefined;
  }
  const plugins: NormalizedPlugin[] = [];
  for (const entry of entries) {
    const [specifier, options] = Array.isArray(entry) ? entry : [entry];
    let mod: any;
    try {
      mod = await import(resolveSpecifier(specifier));
    } catch (error) {
      throw new TypeError(`[env-runner] failed to import plugin "${specifier}".`, {
        cause: error,
      });
    }
    plugins.push(await resolvePlugin(mod?.default, String(specifier), options));
  }
  const byOrder = (order: NormalizedPlugin["order"]) =>
    plugins.filter((plugin) => plugin.order === order);
  const [pre, normal, post] = [byOrder("pre"), byOrder("normal"), byOrder("post")];

  const filter = (id: string, moduleType?: PluginModuleType) => {
    const path = _stripQuery(id).replaceAll("\\", "/");
    if (path.includes("/node_modules/")) {
      return false;
    }
    if (!moduleType) {
      if (!SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext))) {
        return false;
      }
      moduleType = _moduleType(path);
    }
    return plugins.some((plugin) => plugin.prefilter(path, moduleType));
  };

  const transform = (id: string, code: string, sourceType?: PluginModuleType) => {
    id = _stripQuery(id);
    const matchId = id.replaceAll("\\", "/");
    let moduleType = sourceType ?? _moduleType(id);
    // Maps aren't composed: the first map is kept, a second one would be
    // relative to already-mapped code, so both are dropped. Code-only steps
    // keep the current map (they should preserve lines).
    let map: SourceMapLike | null | undefined;
    // Name of the plugin whose map was kept first.
    let mappedBy: string | undefined;
    let changed = false;
    const apply = (
      next: string,
      nextMap: SourceMapLike | null | undefined,
      plugin: NormalizedPlugin,
    ) => {
      if (next === code) {
        return;
      }
      code = next;
      changed = true;
      if (nextMap) {
        if (mappedBy === undefined) {
          map = nextMap;
          mappedBy = plugin.name;
        } else {
          map = undefined;
          _warnDroppedMap(mappedBy, plugin.name);
        }
      }
    };
    const run = (group: NormalizedPlugin[]) => {
      for (const plugin of group) {
        if (!plugin.matches(matchId, code, moduleType)) {
          continue;
        }
        const result = plugin.handler(code, id, moduleType);
        if (typeof (result as any)?.then === "function") {
          throw new TypeError(
            `[env-runner] plugin "${plugin.name}" returned a Promise for "${id}"; transforms must be synchronous.`,
          );
        }
        if (typeof result === "string") {
          apply(result, undefined, plugin);
        } else if (result) {
          apply(result.code ?? code, result.map, plugin);
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
        `[env-runner] "${id}" is still ${moduleType} after its plugins: add one that compiles it to JavaScript (returning \`moduleType: "js"\`) or narrow the plugins' filters.`,
      );
    }
    if (map) {
      const source = isAbsolute(id) ? pathToFileURL(id).href : id;
      const json = JSON.stringify({ ...map, sources: [source], file: undefined });
      code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
    }
    return code;
  };

  return { plugins, filter, transform };
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
 * Transform a matching virtual module (resolved `data.virtual` entry) to plain
 * JS in its format's module system: virtual `.ts`/`.tsx` stay ESM, like
 * untransformed ones. Code formats are candidates, with the format as initial
 * module type. Others, and untouched modules, are returned as is.
 */
export function transformVirtualModule<
  T extends string | { source: string | Uint8Array; format: string },
>(
  pipeline: PluginPipeline,
  key: string,
  module: T,
): T | { source: string; format: "module" | "commonjs" } {
  const format = virtualModuleFormat(key, module as any);
  const moduleType = VIRTUAL_MODULE_TYPES[format];
  if (!moduleType || !pipeline.filter(key, moduleType)) {
    return module;
  }
  const source = typeof module === "string" ? module : (module.source as string);
  const code = pipeline.transform(key, source, moduleType);
  if (code === undefined) {
    return module;
  }
  return { source: code, format: format.startsWith("commonjs") ? "commonjs" : "module" };
}

let _active: PluginPipeline | undefined;
// Bun: the paths the `onLoad` plugin serves.
let _activeBunFilter: RegExp | undefined;

/**
 * Whether this worker's plugin hooks serve a file (on Bun, its `onLoad`
 * filter; used by entry reloads).
 */
export function servedByPluginHooks(path: string): boolean {
  if (!_active) {
    return false;
  }
  return _activeBunFilter ? _activeBunFilter.test(path) : _active.filter(path);
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
 * Run the plugins on matching disk modules in this worker; await before
 * importing the entry. Warns once and skips on runtimes without either backend:
 *
 * - Node.js/Deno: a `module.registerHooks` load hook. Deno evaluates hook
 *   output as ESM, so CommonJS files fall back to its native loader.
 * - Bun: a `Bun.plugin` `onLoad` (can't be removed) with {@link createBunFilter}.
 *   Its output is always evaluated as ESM.
 */
export async function registerPluginHooks(pipeline?: PluginPipeline): Promise<() => void> {
  if (!pipeline) {
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
          if (pipeline.filter(path)) {
            const source = pipeline.transform(path, readFileSync(path, "utf8"));
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
    _active = pipeline;
    return () => {
      if (_active === pipeline) {
        _active = undefined;
      }
      hooks.deregister();
    };
  }
  const bunPlugin = (globalThis as any).Bun?.plugin;
  if (typeof bunPlugin === "function") {
    const filter = createBunFilter(pipeline.plugins);
    bunPlugin({
      name: "env-runner-plugins",
      setup(build: any) {
        build.onLoad({ filter }, ({ path }: { path: string }) => {
          const contents = readFileSync(path, "utf8");
          const code =
            _active === pipeline && pipeline.filter(path)
              ? pipeline.transform(path, contents)
              : undefined;
          // `onLoad` can't decline: untouched code goes to Bun's native loader.
          return code === undefined
            ? { contents, loader: _bunLoader(path) }
            : { contents: code, loader: "js" };
        });
      },
    });
    _active = pipeline;
    _activeBunFilter = filter;
    return () => {
      if (_active === pipeline) {
        _active = undefined;
        _activeBunFilter = undefined;
      }
    };
  }
  console.warn(
    "[env-runner] `plugins` requires `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.x) or `Bun.plugin`; skipping.",
  );
  return _noop;
}

// Extensions a `moduleType` filter implies (never CommonJS ones, see below).
const BUN_EXTENSIONS: Record<string, string[]> = {
  js: [".js", ".mjs"],
  ts: [".ts", ".mts"],
  jsx: [".jsx"],
  tsx: [".tsx"],
};

/**
 * Bun's `onLoad` filter (a single RegExp) for these plugins. Bun evaluates
 * plugin output as ESM and `onLoad` can't decline, so it follows the plugins'
 * prefilters as closely as a RegExp can: no `/node_modules/` (either
 * separator), then one alternative per plugin with
 *
 * - the extensions its `moduleType` filter implies (all non-CommonJS script
 *   extensions without one), never `.cjs`/`.cts`;
 * - its `id` filter: RegExp excludes as a negative lookahead, and includes as
 *   a lookahead when they are all RegExps (otherwise any path).
 *
 * The RegExp takes the `id` RegExps' flags; if they differ, or one has
 * backreferences or named groups (which don't survive being spliced together),
 * no `id` filter is folded in. Bun paths keep native separators. The plugins' filters still
 * decide per module; paths the RegExp lets through but no plugin matches load
 * with Bun's native loader.
 */
export function createBunFilter(plugins: NormalizedPlugin[]): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sep = String.raw`(?:\\|\/)`;
  const isRegExp = (pattern: string | RegExp): pattern is RegExp => pattern instanceof RegExp;
  const idRegExps = plugins.flatMap(({ id }) =>
    id ? [...id.include, ...id.exclude].filter(isRegExp) : [],
  );
  // Stateful flags don't change what matches.
  const flagSet = new Set(idRegExps.map((re) => re.flags.replace(/[gy]/g, "")));
  // Group numbers shift and group names may repeat once sources are joined.
  const foldIds =
    flagSet.size <= 1 && !idRegExps.some((re) => /\\[1-9]|\\k<|\(\?<(?![=!])/.test(re.source));
  const branches = new Set<string>();
  for (const { moduleTypes, id } of plugins) {
    const extensions = moduleTypes
      ? moduleTypes.flatMap((type) => BUN_EXTENSIONS[type] ?? [])
      : Object.values(BUN_EXTENSIONS).flat();
    if (extensions.length === 0) {
      continue;
    }
    let lookaheads = "";
    if (id && foldIds) {
      const exclude = id.exclude.filter(isRegExp);
      if (exclude.length > 0) {
        lookaheads += `(?!.*?(?:${exclude.map((re) => re.source).join("|")}))`;
      }
      if (id.include.length > 0 && id.include.every(isRegExp)) {
        lookaheads += `(?=.*?(?:${id.include.map((re) => (re as RegExp).source).join("|")}))`;
      }
    }
    branches.add(`${lookaheads}.*(?:${[...new Set(extensions)].map(escape).join("|")})$`);
  }
  return new RegExp(
    `^(?!.*${sep}node_modules${sep})(?:${[...branches].join("|") || "(?!)"})`,
    foldIds ? ([...flagSet][0] ?? "") : "",
  );
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
function _moduleType(id: string): PluginModuleType {
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
