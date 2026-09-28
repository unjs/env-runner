import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import {
  createPrefilter,
  isPluginFile,
  moduleTypeOf,
  normalizeFilterId,
  stripQuery,
} from "./filter.ts";
import type { SerializedFilterNode, SerializedPattern, SerializedPrefilter } from "./filter.ts";
import { createTransformClient } from "./channel.ts";
import { commonJSToESM, loadCommonJSLexer } from "../common/virtual-modules.ts";
import type { TransformChannel, TransformedCode } from "./channel.ts";

/** Runner data key of {@link PluginWorkerData} (only set with the `plugins` option). */
export const PLUGINS_DATA_KEY = "__envRunnerPlugins";

/** What a worker gets for the runner's `plugins`. */
export interface PluginWorkerData extends TransformChannel {
  /** `load` and `transform` filters. */
  prefilters: SerializedPrefilter[];
  /** `resolveId` filters (none: imports are never sent). */
  resolvePrefilters?: SerializedPrefilter[];
}

// URL scheme (`registerHooks`) and namespace (Bun) of modules served under an
// id a `resolveId` hook returned that isn't a path (like `\0virtual:foo`).
const PLUGIN_SCHEME = "env-runner-plugin:";
const BUN_NAMESPACE = "env-runner-plugin";

let _active: ((path: string) => boolean) | undefined;

/**
 * Whether this worker's plugin hooks serve a file (on Bun, its `onLoad`
 * filter; used by entry reloads).
 */
export function servedByPluginHooks(path: string): boolean {
  return _active?.(path) ?? false;
}

/**
 * Send matching imports and disk modules to the runner's plugins; await
 * before importing the entry (`entry`: its path or specifier, for `isEntry`).
 *
 * - Imports some `resolveId` filter matches are resolved by the plugins: a
 *   path loads that file, another id is served from the plugins' `load`
 *   hooks (as `env-runner-plugin:<id>` or in that Bun namespace).
 * - A disk module (not under `/node_modules/`) some `load`/`transform`
 *   prefilter may match ({@link createPrefilter}) is loaded by the runner,
 *   and its reply served instead of the file.
 *
 * Output the plugins left as TypeScript is served for the runtime to strip,
 * like an untransformed file. Per runtime:
 *
 * - Node.js/Deno: `module.registerHooks` resolve and load hooks. Deno
 *   evaluates hook output as plain ESM, so TypeScript is stripped here and
 *   CommonJS wrapped (`commonJSToESM()`).
 * - Bun: a `Bun.plugin` (can't be removed) with `onResolve` (only for the
 *   specifiers Bun asks plugins about) and an `onLoad` with
 *   {@link createBunFilter}. Its output is always evaluated as ESM, so
 *   CommonJS is wrapped, also for files the filter passes but no plugin
 *   matches.
 *
 * Warns once and skips on runtimes without either backend.
 */
export async function registerPluginHooks(
  config?: PluginWorkerData,
  entry?: string,
): Promise<() => void> {
  if (!config) {
    return _noop;
  }
  const prefilter = createPrefilter(config.prefilters);
  const matches = (path: string) => {
    const id = normalizeFilterId(path);
    return isPluginFile(id) && prefilter(id, moduleTypeOf(id));
  };
  const resolvePrefilters = config.resolvePrefilters ?? [];
  const resolvePrefilter = createPrefilter(resolvePrefilters);
  const resolves = (source: string) =>
    resolvePrefilters.length > 0 && resolvePrefilter(normalizeFilterId(source), "js");
  const entryId = entry && (entry.startsWith("file:") ? _urlPath(entry) : stripQuery(entry));
  const client = createTransformClient(config);
  await initEsmLexer;
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  const isDeno = "Deno" in globalThis;
  if (isDeno || typeof (globalThis as any).Bun?.plugin === "function") {
    await loadCommonJSLexer();
  }
  if (typeof registerHooks === "function") {
    const cwdURL = pathToFileURL(process.cwd() + "/").href;
    const serve = (
      path: string,
      result: TransformedCode,
      context: { format?: string | null; conditions?: string[]; importAttributes?: any },
    ) => {
      if (result.moduleType === "json") {
        // A JSON module where the import asks for one (or `require()`), else
        // an ES module, so imports without attributes work too.
        if (context.importAttributes?.type === "json" || context.conditions?.includes("require")) {
          return { format: "json" as const, source: result.code, shortCircuit: true };
        }
        const source = `export default JSON.parse(${JSON.stringify(result.code)});\n`;
        return { format: "module" as const, source, shortCircuit: true };
      }
      const format = transformedFormat(path, result.code, context.format);
      if (!isDeno) {
        return {
          format: result.moduleType === "ts" ? (`${format}-typescript` as const) : format,
          source: result.code,
          shortCircuit: true,
        };
      }
      let source = result.code;
      if (result.moduleType === "ts") {
        source = _stripTypes(path, source, stripTypeScriptTypes);
      }
      if (format === "commonjs") {
        source = commonJSToESM(path, source);
      }
      return { format: "module" as const, source, shortCircuit: true };
    };
    const hooks = registerHooks({
      ...(resolvePrefilters.length > 0 && {
        resolve(specifier, context, nextResolve) {
          const source = specifier.startsWith("file:") ? _urlPath(specifier, true) : specifier;
          if (resolves(source)) {
            const isEntry = entryId !== undefined && stripQuery(source) === entryId;
            const importer = isEntry ? undefined : _importerId(context.parentURL);
            const resolved = client.resolve(source, importer, {
              isEntry,
              attributes: context.importAttributes as Record<string, string> | undefined,
            });
            if (resolved && !resolved.external) {
              return { url: _idURL(resolved.id), shortCircuit: true };
            }
            if (resolved && resolved.id !== source) {
              specifier = _idPath(resolved.id) ? _idURL(resolved.id) : resolved.id;
            }
          }
          // Plugin ids aren't hierarchical: their imports resolve from cwd.
          if (context.parentURL?.startsWith(PLUGIN_SCHEME)) {
            return nextResolve(specifier, { ...context, parentURL: cwdURL });
          }
          return nextResolve(specifier, context);
        },
      }),
      load(url, context, nextLoad) {
        if (url.startsWith(PLUGIN_SCHEME)) {
          const id = _schemeId(url);
          return serve(id, client.load(id, true)!, context);
        }
        if (url.startsWith("file:")) {
          const path = fileURLToPath(stripQuery(url));
          if (matches(path)) {
            const result = client.load(path);
            if (result) {
              return serve(path, result, context);
            }
          }
        }
        return nextLoad(url, context);
      },
    });
    _active = matches;
    return () => {
      if (_active === matches) {
        _active = undefined;
      }
      hooks.deregister();
    };
  }
  const bunPlugin = (globalThis as any).Bun?.plugin;
  if (typeof bunPlugin === "function") {
    const filter = createBunFilter(config.prefilters);
    const served = (path: string) => filter.test(path);
    // `onLoad` output is evaluated as ESM, with `loader`.
    const serve = (path: string, result: TransformedCode) => {
      if (result.moduleType === "json") {
        return { exports: { default: _parseJSON(path, result.code) }, loader: "object" };
      }
      const { code } = result;
      return {
        contents: transformedFormat(path, code) === "commonjs" ? commonJSToESM(path, code) : code,
        loader: result.moduleType === "ts" ? "ts" : "js",
      };
    };
    // Bun calls `onResolve` again with the path it returned and no importer.
    const onResolve =
      (namespace?: string) =>
      ({ path, importer }: { path: string; importer: string }) => {
        if (_active !== served || (!namespace && importer === "")) {
          return undefined;
        }
        const source = namespace ? `${namespace}:${path}` : path;
        if (!resolves(source)) {
          return undefined;
        }
        const isEntry = entryId !== undefined && stripQuery(source) === entryId;
        const resolved = client.resolve(source, isEntry ? undefined : _bunImporterId(importer), {
          isEntry,
        });
        if (!resolved || (resolved.external && resolved.id === source)) {
          return undefined;
        }
        if (_idPath(resolved.id)) {
          return { path: resolved.id };
        }
        return resolved.external
          ? undefined
          : { path: encodeURIComponent(resolved.id), namespace: BUN_NAMESPACE };
      };
    bunPlugin({
      name: "env-runner-plugins",
      setup(build: any) {
        build.onLoad({ filter }, ({ path }: { path: string }) => {
          const result = _active === served && matches(path) ? client.load(path) : undefined;
          if (result) {
            return serve(path, result);
          }
          // `onLoad` can't decline: untouched files are served like Bun would.
          const contents = readFileSync(path, "utf8");
          const loader = _bunLoader(path);
          if (loader === "json") {
            return { exports: { default: _parseJSON(path, contents) }, loader: "object" };
          }
          if (!loader) {
            throw new Error(
              `[env-runner] "${path}" matched the runner's plugin filters, but no plugin loaded or transformed it.`,
            );
          }
          return {
            contents:
              transformedFormat(path, contents) === "commonjs"
                ? commonJSToESM(path, contents)
                : contents,
            loader,
          };
        });
        if (resolvePrefilters.length > 0) {
          build.onResolve({ filter: createBunResolveFilter(resolvePrefilters) }, onResolve());
          // `scheme:rest` specifiers only reach their namespace's callbacks.
          for (const scheme of resolveSchemes(resolvePrefilters)) {
            build.onResolve({ filter: /.*/, namespace: scheme }, onResolve(scheme));
          }
        }
        build.onLoad({ filter: /.*/, namespace: BUN_NAMESPACE }, ({ path }: { path: string }) => {
          const id = decodeURIComponent(path);
          return serve(id, client.load(id, true)!);
        });
      },
    });
    _active = served;
    return () => {
      if (_active === served) {
        _active = undefined;
      }
    };
  }
  console.warn(
    "[env-runner] `plugins` requires `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.8) or `Bun.plugin`; skipping.",
  );
  return _noop;
}

// Whether a resolved id is a file path (else a plugin id, like `\0virtual:foo`).
function _idPath(id: string): boolean {
  return isAbsolute(stripQuery(id));
}

// URL serving a resolved id: a `file:` URL (keeping the id's query), or the
// plugin scheme.
function _idURL(id: string): string {
  if (_idPath(id)) {
    const path = stripQuery(id);
    return pathToFileURL(path).href + id.slice(path.length);
  }
  return PLUGIN_SCHEME + encodeURIComponent(id);
}

function _schemeId(url: string): string {
  return decodeURIComponent(stripQuery(url.slice(PLUGIN_SCHEME.length)));
}

// Path of a `file:` URL (with its query when `keepQuery`).
function _urlPath(url: string, keepQuery = false): string {
  const bare = stripQuery(url);
  return fileURLToPath(bare) + (keepQuery ? url.slice(bare.length) : "");
}

// `importer` of a `resolveId` call: a path, a plugin id, or the URL.
function _importerId(parentURL: string | undefined): string | undefined {
  if (!parentURL) {
    return undefined;
  }
  if (parentURL.startsWith("file:")) {
    return _urlPath(parentURL);
  }
  return parentURL.startsWith(PLUGIN_SCHEME) ? _schemeId(parentURL) : parentURL;
}

function _bunImporterId(importer: string): string | undefined {
  if (!importer) {
    return undefined;
  }
  const prefix = `${BUN_NAMESPACE}:`;
  return importer.startsWith(prefix)
    ? decodeURIComponent(importer.slice(prefix.length))
    : stripQuery(importer);
}

// Names the file, as Node's JSON errors do.
function _parseJSON(path: string, source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error: any) {
    throw new SyntaxError(`[env-runner] invalid JSON in "${path}": ${error?.message}`, {
      cause: error,
    });
  }
}

// Deno parses hook output as JavaScript: strip what the plugins left typed.
function _stripTypes(
  path: string,
  code: string,
  stripTypeScriptTypes: ((code: string) => string) | undefined,
): string {
  if (typeof stripTypeScriptTypes !== "function") {
    throw new TypeError(
      `[env-runner] "${path}" is still TypeScript after its plugins, which needs \`module.stripTypeScriptTypes\` (Deno >= 2.8.2) here: upgrade Deno or compile it in a plugin.`,
    );
  }
  try {
    return stripTypeScriptTypes(code);
  } catch (error: any) {
    throw new SyntaxError(
      `[env-runner] failed to strip types from "${path}" after its plugins: ${error?.message || error}`,
      { cause: error },
    );
  }
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
 * separator), then per plugin filter
 *
 * - script files: the extensions its `moduleType` filter implies (all
 *   non-CommonJS script extensions without one, or with filter expressions),
 *   never `.cjs`/`.cts`, and its `id` filter: excludes as a negative
 *   lookahead, and includes as a lookahead (when they can all be folded);
 * - other files (no query), only when its whole `id` filter folds: the
 *   extensions of the other module types it lists, or with an `id` include
 *   and no `moduleType` filter any other extension (not `.json`, `.node` or
 *   `.wasm`, except for `load` filters).
 *
 * Bun paths keep native separators: compiled globs match either one, RegExps
 * written for `/` are only folded where that is the separator (`windows`
 * false). The RegExp takes the folded patterns' flags; if they differ, or one
 * has backreferences or named groups (which don't survive being spliced
 * together), no `id` filter is folded in. The prefilter still decides per
 * module; script (and JSON) files the RegExp lets through but no plugin
 * matches load like Bun would.
 */
export function createBunFilter(
  prefilters: SerializedPrefilter[],
  windows = process.platform === "win32",
): RegExp {
  const sep = String.raw`(?:\\|\/)`;
  const foldable = (pattern: SerializedPattern) => pattern.glob || !windows;
  const plugins = prefilters.map(({ id, moduleTypes, expr, load }) => ({
    moduleTypes: expr ? undefined : moduleTypes,
    exclude: id?.exclude.filter(foldable) ?? [],
    include: id && id.include.length > 0 && id.include.every(foldable) ? id.include : [],
    // Every `id` pattern folds (other files need the exact filter).
    exact: !expr && (!id || [...id.include, ...id.exclude].every(foldable)),
    named: !expr && (id?.include.length ?? 0) > 0,
    load,
  }));
  const folded = plugins.flatMap(({ include, exclude }) => [...include, ...exclude]);
  const flagSet = new Set(folded.map((pattern) => pattern.flags));
  // Group numbers shift and group names may repeat once sources are joined.
  const foldIds =
    flagSet.size <= 1 && !folded.some(({ source }) => /\\[1-9]|\\k<|\(\?<(?![=!])/.test(source));
  const branches = new Set<string>();
  for (const { moduleTypes, include, exclude, exact, named, load } of plugins) {
    let lookaheads = "";
    if (foldIds && exclude.length > 0) {
      lookaheads += `(?!.*?(?:${exclude.map(({ source }) => source).join("|")}))`;
    }
    if (foldIds && include.length > 0) {
      lookaheads += `(?=.*?(?:${include.map(({ source }) => source).join("|")}))`;
    }
    const extensions = moduleTypes
      ? moduleTypes.flatMap((type) => BUN_EXTENSIONS[type] ?? [])
      : Object.values(BUN_EXTENSIONS).flat();
    if (extensions.length > 0) {
      branches.add(`${lookaheads}.*${_extensionGroup(extensions)}$`);
    }
    if (!exact || (!foldIds && (include.length > 0 || exclude.length > 0))) {
      continue;
    }
    if (moduleTypes) {
      const other = moduleTypes.filter((type) => !BUN_EXTENSIONS[type] && /^\w+$/.test(type));
      if (other.length > 0) {
        branches.add(`${lookaheads}[^?]*${_extensionGroup(other.map((type) => `.${type}`))}$`);
      }
    } else if (named) {
      const skipped = load ? String.raw`c[jt]s` : String.raw`c[jt]s|json|node|wasm`;
      branches.add(`${lookaheads}(?![^?]*\\.(?:${skipped})$)[^?]*$`);
    }
  }
  return new RegExp(
    `^(?!.*${sep}node_modules${sep})(?:${[...branches].join("|") || "(?!)"})`,
    foldIds ? ([...flagSet][0] ?? "") : "",
  );
}

/**
 * Bun's `onResolve` filter for `resolveId` prefilters: their `id` includes
 * when every one has some (with the same flags), else any specifier (the
 * prefilter still decides; `onResolve` can decline).
 */
export function createBunResolveFilter(prefilters: SerializedPrefilter[]): RegExp {
  const includes = prefilters.map(({ id, expr }) => (expr ? [] : (id?.include ?? [])));
  const patterns = includes.flat();
  const flags = new Set(patterns.map((pattern) => pattern.flags));
  if (
    includes.some((list) => list.length === 0) ||
    flags.size > 1 ||
    patterns.some(({ source }) => /\\[1-9]|\\k<|\(\?<(?![=!])/.test(source))
  ) {
    return /.*/;
  }
  return new RegExp(patterns.map(({ source }) => `(?:${source})`).join("|"), [...flags][0]);
}

/**
 * URL-like schemes (`virtual` in `virtual:foo`) `resolveId` filters match
 * specifiers of, from the literal start of their `id` patterns: on Bun,
 * `scheme:rest` specifiers only reach that namespace's `onResolve`.
 * Runtime schemes (`node`, `bun`, `file`, ...) and drive letters are skipped.
 */
export function resolveSchemes(prefilters: SerializedPrefilter[]): string[] {
  const schemes = new Set<string>();
  const add = (pattern: SerializedPattern) => {
    const match = /^\^((?:\\?[\w+.-])+?)\\?:/.exec(pattern.source);
    const scheme = match?.[1]!.replaceAll("\\", "");
    if (
      scheme &&
      scheme.length > 1 &&
      /^[a-z][\w+.-]*$/i.test(scheme) &&
      !["node", "bun", "file", "data", "http", "https", "blob"].includes(scheme)
    ) {
      schemes.add(scheme);
    }
  };
  const walk = (node: SerializedFilterNode) => {
    if (node.kind === "id") {
      add(node.pattern);
    } else if (node.kind === "and" || node.kind === "or") {
      node.args.forEach(walk);
    }
  };
  for (const { id, expr } of prefilters) {
    id?.include.forEach(add);
    for (const { kind, expr: node } of expr ?? []) {
      if (kind === "include") {
        walk(node);
      }
    }
  }
  return [...schemes];
}

function _extensionGroup(extensions: string[]): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${[...new Set(extensions)].map(escape).join("|")})`;
}

// Bun's native loader for untouched files (and loads after unregistering),
// `undefined` for files it can't be given back.
function _bunLoader(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts": {
      return "ts";
    }
    case "tsx":
    case "jsx":
    case "json": {
      return ext;
    }
    case "js":
    case "mjs":
    case "cjs": {
      return "js";
    }
  }
  return undefined;
}

const _noop = () => {};
