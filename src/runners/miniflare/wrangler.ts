import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";

/**
 * The `wrangler` package, as imported by the consumer.
 *
 * `wrangler` is not a dependency of `env-runner` — pass the module namespace
 * (`import * as wrangler from "wrangler"`) or a specifier for it, so the
 * dependency stays owned by the application. It is only imported here as a
 * fallback when neither is passed.
 */
export interface WranglerModule {
  unstable_readConfig?: (...args: any[]) => any;
  unstable_getMiniflareWorkerOptions?: (...args: any[]) => any;
  [key: string]: unknown;
}

/** Raw (snake_case) Wrangler config object, mirroring `wrangler.json` contents. */
export type WranglerInlineConfig = Record<string, unknown>;

const WRANGLER_CONFIG_FILENAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

// Miniflare option keys the runner controls itself — never adopt these from a
// wrangler config (`compatibilityFlags` is merged separately by the caller).
const WRANGLER_OPTION_DENYLIST = new Set([
  "name",
  "script",
  "scriptPath",
  "modules",
  "modulesRoot",
  // wrangler always returns default module rules (Text/Data/CompiledWasm); the
  // runner owns module loading via the fallback service + dynamicOnly wrapper
  // and injects its own `.ts/.tsx/.jsx/.mts` rules for `transformRequest`.
  // Adopting wrangler's rules would defeat that injection.
  "modulesRules",
  "unsafeDirectSockets",
  "unsafeEvalBinding",
  "unsafeModuleFallbackService",
  "unsafeUseModuleFallbackService",
]);

// Wrangler-derived options a single fetch-only dev worker can't run: they
// reference other workers (`serviceBindings`, `tails`, `streamingTails`),
// need an asset router / queue / workflow engine wired around the entry
// (`assets`, `queueConsumers`, `workflows`), and make workerd refuse to start
// when the target is missing. Pass them via `miniflareOptions` to opt in.
const WRANGLER_OPTION_DROPLIST = new Set([
  "assets",
  "serviceBindings",
  "workflows",
  "queueConsumers",
  "tails",
  "streamingTails",
]);

// Wrangler config key names for dropped Miniflare options (used in the
// "ignored options" warning, so users recognize their own config keys).
const WRANGLER_DROPPED_OPTION_NAMES: Record<string, string> = {
  assets: "assets",
  serviceBindings: "services",
  workflows: "workflows",
  queueConsumers: "queues.consumers",
  tails: "tail_consumers",
  streamingTails: "streaming_tail_consumers",
  durableObjects: "durable_objects",
};

/**
 * Collects wrangler-derived options that were dropped (config key → binding
 * names/details), deduped across the file and inline configs so a single
 * warning can be emitted per load.
 */
type DroppedWranglerOptions = Map<string, Set<string>>;

function addDropped(dropped: DroppedWranglerOptions, name: string, details: string[]): void {
  let set = dropped.get(name);
  if (!set) {
    set = new Set();
    dropped.set(name, set);
  }
  for (const detail of details) set.add(detail);
}

/** Emit one warning listing every dropped option (no-op when nothing was dropped). */
function warnDroppedWranglerOptions(dropped: DroppedWranglerOptions): void {
  if (dropped.size === 0) {
    return;
  }
  const list = [...dropped]
    .map(([name, details]) => (details.size > 0 ? `${name} (${[...details].join(", ")})` : name))
    .join(", ");
  console.warn(
    `[env-runner] wrangler config options not supported by the miniflare dev runner were ignored: ${list}; pass them via miniflareOptions to opt in.`,
  );
}

/** Whether a value is a plain (non-array, non-null) object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a `wrangler` option value is an inline raw config object. */
function isInlineWranglerConfig(opt: unknown): opt is WranglerInlineConfig {
  return isPlainObject(opt);
}

/** Options for {@link loadWranglerConfig}. */
export interface LoadWranglerConfigOptions {
  /** The runner's `wrangler` option: `true`, a config path, or an inline raw config. */
  wrangler: boolean | string | WranglerInlineConfig;
  /** Wrangler environment (`--env`) to select. */
  env?: string;
  /** Entry file path — anchors config auto-discovery. */
  entryPath?: string;
  /**
   * Explicit config file used instead of auto-discovery when `wrangler` is
   * `true` or an inline object. Ignored when `wrangler` is a string path.
   */
  configPath?: string;
  /** The `wrangler` package (module or specifier), or `false` for the minimal reader. */
  wranglerModule?: RuntimeDep<WranglerModule>;
}

/** Result of {@link loadWranglerConfig}. */
export interface LoadedWranglerConfig {
  /** Partial Miniflare options derived from the config(s). */
  options?: Record<string, unknown>;
  /** Absolute path of the config file that was actually loaded (not set for inline-only configs). */
  configFile?: string;
}

/**
 * Resolve the optional wrangler config into a partial Miniflare options
 * object (compat date/flags + bindings). Accepts a file path, auto-discovery
 * (`true`), or an inline raw config object. When `true` or an inline config
 * is passed, the explicit `configPath` is used as the config file when given,
 * otherwise a file is auto-discovered (next to the entry, then cwd). An inline
 * config is merged on top of the file (inline wins per key, binding records
 * merge, `compatibilityFlags` are unioned).
 *
 * When `wranglerModule` (the imported `wrangler` package or a specifier for
 * it) is supplied it is used for full fidelity; otherwise `wrangler` is
 * imported optionally, and a built-in minimal JSON reader handles plain JSON
 * files and inline objects if that fails. Pass `false` to force the minimal
 * reader. Returns an empty result when `wrangler` is disabled or no config
 * could be loaded.
 */
export async function loadWranglerConfig(
  opts: LoadWranglerConfigOptions,
): Promise<LoadedWranglerConfig> {
  const { wrangler: opt, env, entryPath, wranglerModule } = opts;
  if (!opt) {
    return {};
  }
  const inline = isInlineWranglerConfig(opt) ? opt : undefined;

  // Resolve a config file: an explicit string path wins; `true` and inline
  // objects use `configPath` when given, else auto-discovery. A missing
  // explicit/auto-discovered file warns and aborts, except for an inline
  // config (the inline config is enough on its own).
  let configPath: string | undefined;
  const explicitPath = typeof opt === "string" ? opt : opts.configPath;
  if (explicitPath) {
    configPath = resolve(explicitPath);
    if (!existsSync(configPath)) {
      console.warn(`[env-runner] wrangler config requested but not found at "${configPath}"`);
      if (!inline) {
        return {};
      }
      configPath = undefined;
    }
  } else {
    configPath = findWranglerConfig(entryPath);
    if (!configPath && !inline) {
      console.warn("[env-runner] wrangler config requested but none found near the entry or cwd");
      return {};
    }
  }

  // Use the `wrangler` package for full fidelity (TOML, env inheritance,
  // .dev.vars, every binding type) — the caller-provided module when given,
  // otherwise an optional import. An inline config is normalized through a
  // short-lived temp file (readConfig is file-based).
  const wrangler = await resolveRuntimeDep<WranglerModule>({
    name: "wrangler",
    option: "wranglerModule",
    value: wranglerModule,
  });
  const dropped: DroppedWranglerOptions = new Map();
  if (!wrangler?.unstable_readConfig || !wrangler.unstable_getMiniflareWorkerOptions) {
    const fileOptions = configPath
      ? readWranglerConfigMinimal(configPath, env, dropped)
      : undefined;
    const inlineOptions = inline
      ? mapWranglerConfigToMiniflare(applyWranglerEnv(inline, env), dropped)
      : undefined;
    warnDroppedWranglerOptions(dropped);
    return {
      options: mergeWranglerMiniflareOptions(fileOptions, inlineOptions),
      // `readWranglerConfigMinimal` returns undefined for skipped/unparsable files.
      configFile: fileOptions ? configPath : undefined,
    };
  }

  // File and inline configs are read independently: a failure in one warns
  // (naming its source) without discarding the other's options.
  let fileLoaded = false;
  let fileOptions: Record<string, unknown> | undefined;
  if (configPath) {
    try {
      fileOptions = pickWranglerMiniflareOptions(
        wrangler.unstable_getMiniflareWorkerOptions(
          wrangler.unstable_readConfig({ config: configPath, env }, { hideWarnings: true }),
          env,
        ).workerOptions,
        dropped,
      );
      fileLoaded = true;
    } catch (error) {
      warnWranglerLoadError(`"${configPath}"`, error);
    }
  }
  let inlineOptions: Record<string, unknown> | undefined;
  if (inline) {
    try {
      // `readConfig` throws for an `--env` missing from the config's `env`
      // map, while the file may define it. Like `applyWranglerEnv()`, use the
      // inline top level as-is when it doesn't define the selected env.
      const inlineEnv = env && isPlainObject(inline.env) && inline.env[env] ? env : undefined;
      const { env: _env, ...inlineTopLevel } = inline;
      inlineOptions = pickWranglerMiniflareOptions(
        wrangler.unstable_getMiniflareWorkerOptions(
          readInlineWranglerConfig(wrangler, inlineEnv ? inline : inlineTopLevel, inlineEnv),
          inlineEnv,
        ).workerOptions,
        dropped,
      );
      // `rootPath` points at the deleted temp dir the inline config was
      // normalized in — never let it override the file's `rootPath`.
      if (inlineOptions) {
        delete inlineOptions.rootPath;
      }
    } catch (error) {
      warnWranglerLoadError("(inline)", error);
    }
  }
  warnDroppedWranglerOptions(dropped);
  return {
    options: mergeWranglerMiniflareOptions(fileOptions, inlineOptions),
    configFile: fileLoaded ? configPath : undefined,
  };
}

function warnWranglerLoadError(desc: string, error: unknown): void {
  console.warn(`[env-runner] failed to load wrangler config ${desc}: ${(error as Error).message}`);
}

/**
 * Merge two partial Miniflare option objects derived from wrangler configs
 * (file + inline). `override` wins per key, binding records (`bindings`, KV,
 * etc.) are shallow-merged, and array options (`compatibilityFlags`) are
 * unioned. Returns `undefined` when both inputs are empty.
 */
function mergeWranglerMiniflareOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base) return override;
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (Array.isArray(value) && Array.isArray(prev)) {
      out[key] = [...new Set([...prev, ...value])];
    } else if (isPlainObject(value) && isPlainObject(prev)) {
      out[key] = { ...prev, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Normalize an inline raw config through the `wrangler` package. `readConfig`
 * is file-based, so the object is written to a short-lived temp file (env-runner
 * ignores the config's `main`, so the temp location's relative resolution is
 * irrelevant for our use). Returns the normalized wrangler `Config`.
 */
function readInlineWranglerConfig(wrangler: any, inline: WranglerInlineConfig, env?: string): any {
  const dir = mkdtempSync(join(tmpdir(), "env-runner-wrangler-"));
  const file = join(dir, "wrangler.json");
  try {
    writeFileSync(file, JSON.stringify(inline));
    return wrangler.unstable_readConfig({ config: file, env }, { hideWarnings: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Discover a wrangler config next to the entry file, then in the cwd. */
function findWranglerConfig(entryPath?: string): string | undefined {
  const dirs: string[] = [];
  if (entryPath) {
    const resolved = isAbsolute(entryPath) ? entryPath : resolve(entryPath);
    dirs.push(dirname(resolved));
  }
  dirs.push(process.cwd());
  for (const dir of dirs) {
    for (const name of WRANGLER_CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Keep the binding/compat fields from wrangler's `unstable_getMiniflareWorkerOptions`
 * output, dropping keys the runner manages (entry script, module fallback,
 * direct sockets, etc.), options a single dev worker can't run (service
 * bindings, assets, queue consumers, workflows, tails), Durable Object
 * bindings that target another script, and empty records/arrays. Non-empty
 * dropped options are recorded in `dropped` for the load warning. The
 * returned object is spread under `miniflareOptions`.
 */
function pickWranglerMiniflareOptions(
  workerOptions: Record<string, unknown>,
  dropped: DroppedWranglerOptions,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workerOptions)) {
    if (value === undefined || WRANGLER_OPTION_DENYLIST.has(key)) {
      continue;
    }
    if (WRANGLER_OPTION_DROPLIST.has(key)) {
      // wrangler returns `{}`/`[]` for unused types — only report real values.
      if (!isEmptyOption(value)) {
        addDropped(dropped, WRANGLER_DROPPED_OPTION_NAMES[key]!, describeDroppedOption(value));
      }
      continue;
    }
    const picked = key === "durableObjects" ? filterLocalDurableObjects(value, dropped) : value;
    if (
      (Array.isArray(picked) && picked.length === 0) ||
      (isPlainObject(picked) && Object.keys(picked).length === 0)
    ) {
      continue;
    }
    out[key] = picked;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whether a wrangler-derived option value is empty (`{}`/`[]`/falsy). */
function isEmptyOption(value: unknown): boolean {
  return (
    !value ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

/**
 * Binding names for a dropped option: record keys (`serviceBindings`,
 * `workflows`, `queueConsumers`), `name`s of array entries (`tails`), or the
 * `binding` of a single object (`assets`).
 */
function describeDroppedOption(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => entry?.name).filter((name) => typeof name === "string");
  }
  if (isPlainObject(value)) {
    if ("directory" in value) {
      return typeof value.binding === "string" ? [value.binding] : [];
    }
    return Object.keys(value);
  }
  return [];
}

/**
 * Keep Durable Object bindings served by this worker (a class name string, or
 * an object without `scriptName`); bindings to another script's class can't
 * resolve in a single-worker Miniflare and would stop workerd from starting.
 */
function filterLocalDurableObjects(value: unknown, dropped: DroppedWranglerOptions): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([name, binding]) => {
      if (typeof binding === "string" || (isPlainObject(binding) && !binding.scriptName)) {
        return true;
      }
      const scriptName = isPlainObject(binding) ? binding.scriptName : undefined;
      addDropped(dropped, "durable_objects", [`${name} → script "${String(scriptName)}"`]);
      return false;
    }),
  );
}

/**
 * Minimal wrangler-config reader used when the `wrangler` package is absent.
 * Parses plain JSON only and maps the common fields to Miniflare options.
 * JSONC and TOML files need the `wrangler` package and are skipped with a
 * warning.
 */
function readWranglerConfigMinimal(
  configPath: string,
  env: string | undefined,
  dropped: DroppedWranglerOptions,
): Record<string, unknown> | undefined {
  if (extname(configPath).toLowerCase() !== ".json") {
    console.warn(
      `[env-runner] reading "${basename(configPath)}" requires the 'wrangler' package; the built-in reader supports plain JSON only (install 'wrangler' for JSONC/TOML).`,
    );
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  let config: Record<string, any>;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[env-runner] failed to parse wrangler config "${configPath}": ${(error as Error).message}`,
    );
    return undefined;
  }
  // `{}` (not undefined) marks the file as loaded even without mapped fields.
  return mapWranglerConfigToMiniflare(applyWranglerEnv(config, env), dropped) ?? {};
}

/**
 * Shallow `--env` override of the selected fields. Real wrangler inheritance is
 * more nuanced (bindings are not inherited into named environments), but this
 * covers the common case for the minimal fallback path.
 */
function applyWranglerEnv(config: Record<string, any>, env?: string): Record<string, any> {
  return env && config.env?.[env] ? { ...config, ...config.env[env] } : config;
}

/**
 * Map raw (snake_case) wrangler config fields to Miniflare option shapes.
 * Unsupported fields the real-package path drops (services, assets, queue
 * consumers, workflows, tails, external-script DOs) are recorded in `dropped`.
 */
function mapWranglerConfigToMiniflare(
  config: Record<string, any>,
  dropped: DroppedWranglerOptions,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [name, value, field] of [
    ["services", config.services, "binding"],
    ["assets", config.assets, "binding"],
    ["queues.consumers", config.queues?.consumers, "queue"],
    ["workflows", config.workflows, "binding"],
    ["tail_consumers", config.tail_consumers, "service"],
    ["streaming_tail_consumers", config.streaming_tail_consumers, "service"],
  ] as const) {
    if (!isEmptyOption(value)) {
      const entries: any[] = Array.isArray(value) ? value : [value];
      const details = entries.map((e) => e?.[field]).filter((d) => typeof d === "string");
      addDropped(dropped, name, details);
    }
  }
  if (typeof config.compatibility_date === "string") {
    out.compatibilityDate = config.compatibility_date;
  }
  if (Array.isArray(config.compatibility_flags)) {
    out.compatibilityFlags = config.compatibility_flags;
  }
  if (config.vars && typeof config.vars === "object") {
    out.bindings = { ...config.vars };
  }
  const kv = mapBindingArray(config.kv_namespaces, "binding", (n) => n.id ?? n.binding);
  if (kv) out.kvNamespaces = kv;
  const r2 = mapBindingArray(config.r2_buckets, "binding", (n) => n.bucket_name ?? n.binding);
  if (r2) out.r2Buckets = r2;
  const d1 = mapBindingArray(
    config.d1_databases,
    "binding",
    (n) => n.database_id ?? n.preview_database_id ?? n.binding,
  );
  if (d1) out.d1Databases = d1;
  const queues = mapBindingArray(config.queues?.producers, "binding", (n) => n.queue);
  if (queues) out.queueProducers = queues;
  if (Array.isArray(config.durable_objects?.bindings)) {
    const dos: Record<string, unknown> = {};
    for (const b of config.durable_objects.bindings) {
      // Bindings to another script's class can't run in a single-worker dev
      // Miniflare (see `filterLocalDurableObjects`).
      if (!b?.name || !b?.class_name) continue;
      if (b.script_name) {
        addDropped(dropped, "durable_objects", [`${b.name} → script "${b.script_name}"`]);
        continue;
      }
      dos[b.name] = b.class_name;
    }
    if (Object.keys(dos).length > 0) out.durableObjects = dos;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Turn a wrangler binding array (`[{ binding, ... }]`) into a Miniflare record. */
function mapBindingArray(
  arr: unknown,
  keyField: string,
  value: (entry: any) => unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(arr)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const entry of arr) {
    const key = entry?.[keyField];
    if (typeof key === "string") {
      out[key] = value(entry);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
