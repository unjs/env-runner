import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import {
  createPrefilter,
  isNodeModulesId,
  nodeModulesIncludes,
  moduleTypeOf,
  normalizeFilterId,
  queryOf,
  restoreInternalQuery,
  stripInternalQuery,
  stripQuery,
} from "./filter.ts";
import type { SerializedFilterNode, SerializedPattern, SerializedPrefilter } from "./filter.ts";
import { createTransformClient } from "./channel.ts";
import { commonJSToESM, loadCommonJSLexer, virtualFileVersion } from "../common/virtual-modules.ts";
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

// Bun: specifiers with another extension than scripts (with a query), and
// the marker leading the query of the files the plugins loaded for them.
const BUN_OTHER_FILE = /\.(?![cm]?[jt]sx?(?:\?|$))[\w-]+(?:\?.*)?$/i;
const BUN_LOADED_MARKER = "__env_runner_plugin";
const BUN_LOADED_FILE = new RegExp(String.raw`\?${BUN_LOADED_MARKER}(?:&|$)`);

interface BunResolveArgs {
  path: string;
  importer: string;
}

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
 *   specifiers Bun asks plugins about) and an `onLoad` for scripts with
 *   {@link createBunFilter}. Its output is always evaluated as ESM, so
 *   CommonJS is wrapped, also for files the filter passes but no plugin
 *   matches. Other file types are loaded in `onResolve`, which can decline,
 *   so files no plugin changes keep Bun's native loaders.
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
  // `id`: a path with the import's query; `resolved`: a path a `resolveId`
  // hook returned (may be in node_modules).
  const matches = (id: string, resolved?: boolean) => {
    const filterId = normalizeFilterId(id);
    return prefilter(filterId, moduleTypeOf(filterId), resolved);
  };
  // Paths `resolveId` hooks returned (Node.js/Deno).
  const pluginResolved = new Set<string>();
  const resolvePrefilters = config.resolvePrefilters ?? [];
  // Hooks before the runtime resolves an import, and for failures (`fallback`).
  const resolveTest = (fallback: boolean) => {
    const prefilters = resolvePrefilters.filter((prefilter) => !prefilter.fallback === !fallback);
    const test = createPrefilter(prefilters);
    return (source: string) => prefilters.length > 0 && test(normalizeFilterId(source), "js", true);
  };
  const resolves = resolveTest(false);
  const resolvesFailed = resolveTest(true);
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
        return {
          format: "module" as const,
          source: jsonModuleCode(path, result.code),
          shortCircuit: true,
        };
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
          const raw = specifier.startsWith("file:") ? _urlPath(specifier, true) : specifier;
          // A reload's cache-busting param stays out of the plugins' view, and
          // goes back on the result.
          const source = stripInternalQuery(raw);
          const ask = (fallback: boolean) => {
            const isEntry = entryId !== undefined && stripQuery(source) === entryId;
            const resolved = client.resolve(
              source,
              isEntry ? undefined : _importerId(context.parentURL),
              {
                isEntry,
                attributes: context.importAttributes as Record<string, string> | undefined,
                fallback,
              },
            );
            if (resolved && !resolved.external) {
              if (_idPath(resolved.id)) {
                pluginResolved.add(stripQuery(resolved.id));
              }
              return { url: restoreInternalQuery(_idURL(resolved.id), raw), shortCircuit: true };
            }
            if (resolved && resolved.id !== source) {
              specifier = restoreInternalQuery(
                _idPath(resolved.id) ? _idURL(resolved.id) : resolved.id,
                raw,
              );
            }
            return resolved;
          };
          const before = resolves(source) ? ask(false) : undefined;
          if (before && "url" in before) {
            return before;
          }
          // Plugin ids aren't hierarchical: their imports resolve from cwd.
          const parent = context.parentURL?.startsWith(PLUGIN_SCHEME)
            ? { ...context, parentURL: cwdURL }
            : context;
          if (!resolvesFailed(source)) {
            return nextResolve(specifier, parent);
          }
          let result: ReturnType<typeof nextResolve> | undefined;
          let failure: unknown;
          try {
            result = nextResolve(specifier, parent);
          } catch (error) {
            failure = error;
          }
          // Deno resolves paths without a file (loading them fails).
          if (result && !(result.url.startsWith("file:") && !existsSync(_urlPath(result.url)))) {
            return result;
          }
          const resolved = ask(true);
          if (resolved && "url" in resolved) {
            return resolved;
          }
          if (resolved) {
            return nextResolve(specifier, parent);
          }
          if (failure !== undefined) {
            throw failure;
          }
          return result!;
        },
      }),
      load(url, context, nextLoad) {
        if (url.startsWith(PLUGIN_SCHEME)) {
          const id = _schemeId(url);
          return serve(id, client.load(id, true)!, context);
        }
        if (url.startsWith("file:")) {
          const id = _fileId(url);
          const resolved = pluginResolved.has(stripQuery(id));
          if (matches(id, resolved)) {
            const result = client.load(id, false, resolved);
            if (result) {
              return serve(stripQuery(id), result, context);
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
        // Like Bun's JSON modules: top-level keys are named exports too.
        const value = _parseJSON(path, result.code);
        const named = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        return { exports: { ...named, default: value }, loader: "object" };
      }
      const { code } = result;
      return {
        contents: transformedFormat(path, code) === "commonjs" ? commonJSToESM(path, code) : code,
        loader: result.moduleType === "ts" ? "ts" : "js",
      };
    };
    // Other file types are loaded while resolving, where Bun still accepts no
    // result (it loads any file natively, unknown ones as a path): served
    // with a marker param (before the import's query), kept here by id until
    // Bun loads them (it resolves a static import twice first).
    const loaded = new Map<string, TransformedCode>();
    const loadOther = (id: string, resolved?: boolean) => {
      const result =
        loaded.get(id) ?? (matches(id, resolved) ? client.load(id, false, resolved) : undefined);
      if (!result) {
        return undefined;
      }
      loaded.set(id, result);
      const query = queryOf(id);
      return { path: `${stripQuery(id)}?${BUN_LOADED_MARKER}${query && `&${query.slice(1)}`}` };
    };
    // Bun calls `onResolve` again with the path it returned and no importer.
    const onResolve =
      (namespace?: string) =>
      ({ path, importer }: BunResolveArgs) => {
        if (_bunResolving || _active !== served || (!namespace && importer === "")) {
          return undefined;
        }
        const raw = namespace ? `${namespace}:${path}` : path;
        const source = stripInternalQuery(raw);
        const before = resolves(source);
        if (!before && !resolvesFailed(source)) {
          return undefined;
        }
        const isEntry = entryId !== undefined && stripQuery(source) === entryId;
        const importerId = isEntry ? undefined : _bunImporterId(importer);
        let resolved = before ? client.resolve(source, importerId, { isEntry }) : undefined;
        // `onResolve` runs before Bun resolves: ask Bun first.
        if (!resolved && resolvesFailed(source) && !_bunResolves(raw, importer)) {
          resolved = client.resolve(source, importerId, { isEntry, fallback: true });
        }
        if (!resolved || (resolved.external && resolved.id === source)) {
          return undefined;
        }
        if (_idPath(resolved.id)) {
          // Other file types, and node_modules files the `onLoad` filter
          // leaves out, are loaded here.
          const file = stripQuery(resolved.id);
          const here = BUN_OTHER_FILE.test(file) || isNodeModulesId(normalizeFilterId(file));
          return (
            (!resolved.external && here && loadOther(resolved.id, true)) || {
              path: restoreInternalQuery(resolved.id, raw),
            }
          );
        }
        return resolved.external
          ? undefined
          : { path: encodeURIComponent(resolved.id), namespace: BUN_NAMESPACE };
      };
    bunPlugin({
      name: "env-runner-plugins",
      setup(build: any) {
        // Bun keeps a path's query, in `path` and the module's identity.
        build.onLoad({ filter }, ({ path }: { path: string }) => {
          const id = _bunId(path);
          const file = stripQuery(path);
          const result = _active === served && matches(id) ? client.load(id) : undefined;
          if (result) {
            return serve(file, result);
          }
          // `onLoad` can't decline: untouched code is served with the loader
          // Bun would use.
          const contents = readFileSync(file, "utf8");
          return {
            contents:
              transformedFormat(file, contents) === "commonjs"
                ? commonJSToESM(file, contents)
                : contents,
            loader: _bunLoader(file),
          };
        });
        if (resolvePrefilters.length > 0) {
          build.onResolve({ filter: createBunResolveFilter(resolvePrefilters) }, onResolve());
          // `scheme:rest` specifiers only reach their namespace's callbacks.
          for (const scheme of resolveSchemes(resolvePrefilters)) {
            build.onResolve({ filter: /.*/, namespace: scheme }, onResolve(scheme));
          }
        }
        build.onResolve({ filter: BUN_OTHER_FILE }, ({ path, importer }: BunResolveArgs) => {
          const file = _active === served && importer ? _bunFilePath(path, importer) : undefined;
          return file === undefined ? undefined : loadOther(_bunId(file + queryOf(path)));
        });
        build.onLoad({ filter: BUN_LOADED_FILE }, ({ path }: { path: string }) => {
          const id = _bunId(path);
          const result = loaded.get(id) ?? client.load(id);
          loaded.delete(id);
          if (!result) {
            throw new Error(`[env-runner] no plugin loaded or transformed "${id}" anymore`);
          }
          return serve(stripQuery(path), result);
        });
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

// Set while `_bunResolves()` runs: `Bun.resolveSync()` calls the plugins'
// `onResolve` callbacks again.
let _bunResolving = false;

// Whether Bun resolves a specifier from `importer` (a path, or a plugin id).
function _bunResolves(specifier: string, importer: string): boolean {
  const from = stripQuery(importer);
  _bunResolving = true;
  try {
    (globalThis as any).Bun.resolveSync(
      stripQuery(specifier),
      isAbsolute(from) ? dirname(from) : process.cwd(),
    );
    return true;
  } catch {
    return false;
  } finally {
    _bunResolving = false;
  }
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

// Path of a `file:` URL (with its query, without a fragment, when `keepQuery`).
function _urlPath(url: string, keepQuery = false): string {
  return fileURLToPath(stripQuery(url)) + (keepQuery ? queryOf(url) : "");
}

// Module id of a `file:` URL: its path with the import's query, without the
// params env-runner added (reloads, virtual module versions).
function _fileId(url: string): string {
  const bare = url.slice(0, url.search(/[?#]|$/));
  return stripInternalQuery(_urlPath(url, true), virtualFileVersion(bare));
}

// Module id of a Bun path (Bun markers and virtual versions removed).
function _bunId(path: string): string {
  return stripInternalQuery(path, virtualFileVersion(stripQuery(path)));
}

// `importer` of a `resolveId` call: a path, a plugin id, or the URL.
function _importerId(parentURL: string | undefined): string | undefined {
  if (!parentURL) {
    return undefined;
  }
  if (parentURL.startsWith("file:")) {
    return _fileId(parentURL);
  }
  return parentURL.startsWith(PLUGIN_SCHEME) ? _schemeId(parentURL) : parentURL;
}

function _bunImporterId(importer: string): string | undefined {
  if (!importer) {
    return undefined;
  }
  const prefix = `${BUN_NAMESPACE}:`;
  if (importer.startsWith(prefix)) {
    return decodeURIComponent(importer.slice(prefix.length));
  }
  return isAbsolute(stripQuery(importer)) ? _bunId(importer) : stripQuery(importer);
}

// Path a relative or absolute Bun specifier (query stripped) refers to;
// `undefined` for bare ones (packages).
function _bunFilePath(specifier: string, importer: string): string | undefined {
  const path = stripQuery(specifier);
  if (isAbsolute(path)) {
    return path;
  }
  if (!/^\.\.?[\\/]/.test(path)) {
    return undefined;
  }
  const from = stripQuery(importer);
  return resolve(isAbsolute(from) ? dirname(from) : process.cwd(), path);
}

/**
 * JSON as an ES module: the value as default export, and the top-level keys
 * of an object as named exports (any key, as string export names). Throws for
 * invalid JSON, naming `path`.
 */
export function jsonModuleCode(path: string, json: string): string {
  const value = _parseJSON(path, json);
  const lines = [`const json = JSON.parse(${JSON.stringify(json)});`, "export default json;"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    let index = 0;
    for (const key of Object.keys(value)) {
      if (key !== "default") {
        const local = `json${index++}`;
        lines.push(
          `const ${local} = json[${JSON.stringify(key)}];`,
          `export { ${local} as ${JSON.stringify(key)} };`,
        );
      }
    }
  }
  return lines.join("\n") + "\n";
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
  const file = stripQuery(path);
  if (/\.m[jt]sx?$/.test(file)) {
    return "module";
  }
  if (/\.c[jt]sx?$/.test(file)) {
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
 * prefilters as closely as a RegExp can: no Bun marker query
 * (`__env_runner_*`), then one alternative per plugin with no
 * `/node_modules/` (either separator; unless its folded `id` includes name
 * it), and
 *
 * - the extensions its `moduleType` filter implies (all non-CommonJS script
 *   extensions without one, or with filter expressions), never `.cjs`/`.cts`,
 *   before an optional query;
 * - its `id` filter: excludes as a negative lookahead, and includes as a
 *   lookahead (when they can all be folded).
 *
 * Bun paths keep native separators: compiled globs match either one, RegExps
 * written for `/` are only folded where that is the separator (`windows`
 * false). The RegExp takes the folded patterns' flags; if they differ, or one
 * has backreferences or named groups (which don't survive being spliced
 * together), no `id` filter is folded in. The prefilter still decides per
 * module; paths the RegExp lets through but no plugin matches load with Bun's
 * native loader.
 */
export function createBunFilter(
  prefilters: SerializedPrefilter[],
  windows = process.platform === "win32",
): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sep = String.raw`(?:\\|\/)`;
  const foldable = (pattern: SerializedPattern) => pattern.glob || !windows;
  const plugins = prefilters.map((prefilter) => {
    const { id, moduleTypes, expr } = prefilter;
    const include = id && id.include.length > 0 && id.include.every(foldable) ? id.include : [];
    return {
      moduleTypes: expr ? undefined : moduleTypes,
      exclude: id?.exclude.filter(foldable) ?? [],
      include,
      // Its includes name `node_modules` and fold: no `node_modules` guard.
      nodeModules: include.length > 0 && nodeModulesIncludes(prefilter).length > 0,
    };
  });
  const folded = plugins.flatMap(({ include, exclude }) => [...include, ...exclude]);
  const flagSet = new Set(folded.map((pattern) => pattern.flags));
  // Group numbers shift and group names may repeat once sources are joined.
  const foldIds =
    flagSet.size <= 1 && !folded.some(({ source }) => /\\[1-9]|\\k<|\(\?<(?![=!])/.test(source));
  const branches = new Set<string>();
  // Checked on the path (before a query).
  const guard = `(?![^?]*${sep}node_modules${sep})`;
  for (const { moduleTypes, include, exclude, nodeModules } of plugins) {
    const extensions = moduleTypes
      ? moduleTypes.flatMap((type) => BUN_EXTENSIONS[type] ?? [])
      : Object.values(BUN_EXTENSIONS).flat();
    if (extensions.length === 0) {
      continue;
    }
    let lookaheads = "";
    if (foldIds && exclude.length > 0) {
      lookaheads += `(?!.*?(?:${exclude.map(({ source }) => source).join("|")}))`;
    }
    if (foldIds && include.length > 0) {
      lookaheads += `(?=.*?(?:${include.map(({ source }) => source).join("|")}))`;
    }
    if (nodeModules && !foldIds) {
      lookaheads = guard;
    } else if (!nodeModules) {
      lookaheads = guard + lookaheads;
    }
    const exts = [...new Set(extensions)].map(escape).join("|");
    branches.add(`${lookaheads}[^?]*(?:${exts})(?:\\?.*)?$`);
  }
  // Paths under a Bun marker have their own `onLoad` (or load from disk).
  const marker = String.raw`\?__env_runner_(?:virtual|disk|plugin)(?:&|$)`;
  return new RegExp(
    `^(?![^?]*${marker})(?:${[...branches].join("|") || "(?!)"})`,
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

const _noop = () => {};
