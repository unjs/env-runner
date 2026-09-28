import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import {
  createPrefilter,
  isTransformCandidate,
  moduleTypeOf,
  normalizeFilterId,
  stripQuery,
} from "./filter.ts";
import type { SerializedPattern, SerializedPrefilter } from "./filter.ts";
import { createTransformClient } from "./channel.ts";
import { commonJSToESM, loadCommonJSLexer } from "../common/virtual-modules.ts";
import type { TransformChannel } from "./channel.ts";

/** Runner data key of {@link PluginWorkerData} (only set with the `plugins` option). */
export const PLUGINS_DATA_KEY = "__envRunnerPlugins";

/** What a worker gets for the runner's `plugins`. */
export interface PluginWorkerData extends TransformChannel {
  prefilters: SerializedPrefilter[];
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
 * Send matching disk modules to the runner's plugins; await before importing
 * the entry. A module is sent when it is a candidate
 * ({@link isTransformCandidate}) and some plugin's prefilter may match
 * ({@link createPrefilter}); the runner's reply is served instead of the
 * file. Warns once and skips on runtimes without either backend:
 *
 * Output the plugins left as TypeScript is served for the runtime to strip,
 * like an untransformed file. Per runtime:
 *
 * - Node.js/Deno: a `module.registerHooks` load hook. Deno evaluates hook
 *   output as plain ESM, so TypeScript is stripped here and CommonJS wrapped
 *   (`commonJSToESM()`).
 * - Bun: a `Bun.plugin` `onLoad` (can't be removed) with {@link createBunFilter}.
 *   Its output is always evaluated as ESM, so CommonJS is wrapped, also for
 *   files the filter passes but no plugin matches.
 */
export async function registerPluginHooks(config?: PluginWorkerData): Promise<() => void> {
  if (!config) {
    return _noop;
  }
  const prefilter = createPrefilter(config.prefilters);
  const matches = (path: string) => {
    const id = normalizeFilterId(path);
    return isTransformCandidate(id) && prefilter(id, moduleTypeOf(id));
  };
  const transform = createTransformClient(config);
  await initEsmLexer;
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  const isDeno = "Deno" in globalThis;
  if (isDeno || typeof (globalThis as any).Bun?.plugin === "function") {
    await loadCommonJSLexer();
  }
  if (typeof registerHooks === "function") {
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith("file:")) {
          const path = fileURLToPath(stripQuery(url));
          if (matches(path)) {
            const result = transform(path, readFileSync(path, "utf8"));
            if (result) {
              const format = transformedFormat(path, result.code, context.format);
              if (!isDeno) {
                return {
                  format: result.moduleType === "ts" ? `${format}-typescript` : format,
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
              return { format: "module", source, shortCircuit: true };
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
    bunPlugin({
      name: "env-runner-plugins",
      setup(build: any) {
        build.onLoad({ filter }, ({ path }: { path: string }) => {
          const contents = readFileSync(path, "utf8");
          const result =
            _active === served && matches(path) ? transform(path, contents) : undefined;
          // `onLoad` can't decline: untouched code is served with the loader
          // Bun would use.
          const code = result?.code ?? contents;
          const loader = result ? (result.moduleType === "ts" ? "ts" : "js") : _bunLoader(path);
          return {
            contents:
              transformedFormat(path, code) === "commonjs" ? commonJSToESM(path, code) : code,
            loader,
          };
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
 * separator), then one alternative per plugin with
 *
 * - the extensions its `moduleType` filter implies (all non-CommonJS script
 *   extensions without one, or with filter expressions), never `.cjs`/`.cts`;
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
  const plugins = prefilters.map(({ id, moduleTypes, expr }) => ({
    moduleTypes: expr ? undefined : moduleTypes,
    exclude: id?.exclude.filter(foldable) ?? [],
    include: id && id.include.length > 0 && id.include.every(foldable) ? id.include : [],
  }));
  const folded = plugins.flatMap(({ include, exclude }) => [...include, ...exclude]);
  const flagSet = new Set(folded.map((pattern) => pattern.flags));
  // Group numbers shift and group names may repeat once sources are joined.
  const foldIds =
    flagSet.size <= 1 && !folded.some(({ source }) => /\\[1-9]|\\k<|\(\?<(?![=!])/.test(source));
  const branches = new Set<string>();
  for (const { moduleTypes, include, exclude } of plugins) {
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

const _noop = () => {};
