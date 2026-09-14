import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";

/** The `wrangler` package namespace, as imported by the app. */
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
  // wrangler's default rules would override the runner's own `transformRequest` rules.
  "modulesRules",
  "unsafeDirectSockets",
  "unsafeEvalBinding",
  "unsafeModuleFallbackService",
  "unsafeUseModuleFallbackService",
]);

// Options a single fetch-only dev worker can't run (workerd refuses to start
// without their targets). Opt in via `miniflareOptions`.
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

/** Dropped options, deduped across file and inline configs for a single warning. */
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
  /** See `MiniflareEnvRunnerOptions.wranglerConfigPath`. */
  configPath?: string;
  /** The `wrangler` package (module or specifier), or `false` for the minimal reader. */
  wranglerModule?: RuntimeDep<WranglerModule>;
  /** See `MiniflareEnvRunnerOptions.wranglerEnvFiles`. */
  envFiles?: string[];
}

/** Result of {@link loadWranglerConfig}. */
export interface LoadedWranglerConfig {
  /** Partial Miniflare options derived from the config(s). */
  options?: Record<string, unknown>;
  /** Absolute path of the config file that was actually loaded (not set for inline-only configs). */
  configFile?: string;
}

/** Resolve the `wrangler` option into Miniflare options (see `MiniflareEnvRunnerOptions.wrangler`). */
export async function loadWranglerConfig(
  opts: LoadWranglerConfigOptions,
): Promise<LoadedWranglerConfig> {
  const { wrangler: opt, env, entryPath, wranglerModule, envFiles } = opts;
  if (!opt) {
    return {};
  }
  const inline = isInlineWranglerConfig(opt) ? opt : undefined;

  // A missing file aborts, unless an inline config can stand on its own.
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
      console.warn(
        "[env-runner] wrangler config requested but none found (searched the entry's directory, then from the cwd up to the filesystem root)",
      );
      return {};
    }
  }

  const wrangler = await resolveRuntimeDep<WranglerModule>({
    name: "wrangler",
    option: "wranglerModule",
    value: wranglerModule,
  });
  const dropped: DroppedWranglerOptions = new Map();
  if (!wrangler?.unstable_readConfig || !wrangler.unstable_getMiniflareWorkerOptions) {
    if (envFiles && !_warnedMinimalEnvFiles) {
      _warnedMinimalEnvFiles = true;
      console.warn(
        "[env-runner] `wranglerEnvFiles` requires the 'wrangler' package and is ignored by the built-in minimal wrangler config reader.",
      );
    }
    const fileMeta: { workerName?: string } = {};
    const fileOptions = configPath
      ? readWranglerConfigMinimal(configPath, env, dropped, fileMeta)
      : undefined;
    const inlineOptions = inline
      ? mapWranglerConfigToMiniflare(applyWranglerEnv(inline, env), dropped)
      : undefined;
    const options = mergeWranglerMiniflareOptions(fileOptions, inlineOptions);
    filterLocalDurableObjects(
      options,
      dropped,
      (inline && wranglerWorkerName(inline, env)) ?? fileMeta.workerName,
    );
    warnDroppedWranglerOptions(dropped);
    return {
      options,
      // `readWranglerConfigMinimal` returns undefined for skipped/unparsable files.
      configFile: fileOptions ? configPath : undefined,
    };
  }

  // File and inline configs are read independently: a failure in one warns
  // (naming its source) without discarding the other's options.
  let fileLoaded = false;
  let fileOptions: Record<string, unknown> | undefined;
  let fileSecrets: unknown;
  let fileWorkerName: string | undefined;
  if (configPath) {
    try {
      const config = wrangler.unstable_readConfig(
        { config: configPath, env },
        { hideWarnings: !claimWranglerWarnings(configPath, env) },
      );
      fileOptions = pickWranglerMiniflareOptions(
        wrangler.unstable_getMiniflareWorkerOptions(config, env, { envFiles }).workerOptions,
        dropped,
      );
      fileWorkerName = config?.name;
      fileSecrets = config?.secrets;
      fileLoaded = true;
    } catch (error) {
      warnWranglerLoadError(`"${configPath}"`, error);
    }
  }
  let inlineOptions: Record<string, unknown> | undefined;
  if (inline) {
    try {
      // `readConfig` throws for an `--env` the inline config lacks (the file may
      // define it); use its top level as-is, like `applyWranglerEnv()`.
      const inlineEnv = env && isPlainObject(inline.env) && inline.env[env] ? env : undefined;
      const { env: _env, ...inlineTopLevel } = inline;
      const inlineConfig = readInlineWranglerConfig(
        wrangler,
        inlineEnv ? inline : inlineTopLevel,
        inlineEnv,
      );
      // Dev-var files resolve from `userConfigPath` (the deleted temp dir), so
      // re-anchor to the project. Reading them here also keeps inline `vars`
      // from beating the file's secrets (`.dev.vars` wins within each read).
      inlineConfig.userConfigPath = configPath;
      // Read the inline part under the file's `secrets` declaration (as if
      // merged): explicit-secrets mode only loads declared keys (+ process.env).
      if (fileLoaded && inlineConfig.secrets === undefined) {
        inlineConfig.secrets = fileSecrets;
      }
      inlineOptions = pickWranglerMiniflareOptions(
        wrangler.unstable_getMiniflareWorkerOptions(
          inlineConfig,
          // Only used for the dev-vars lookup (`.dev.vars.<env>`): keep the
          // selected env even when the inline config doesn't define it.
          env,
          { envFiles },
        ).workerOptions,
        dropped,
      );
      // `rootPath` must never override the file's `rootPath` (and without a
      // file it adds nothing over Miniflare's cwd default).
      if (inlineOptions) {
        delete inlineOptions.rootPath;
        if (fileLoaded) {
          filterInlineDevVarBindings(inlineOptions, fileOptions, inlineConfig);
        }
      }
    } catch (error) {
      warnWranglerLoadError("(inline)", error);
    }
  }
  const options = mergeWranglerMiniflareOptions(fileOptions, inlineOptions);
  // Durable Objects are filtered after the merge, against the effective
  // worker name: the inline config's `name` when set, else the file's.
  filterLocalDurableObjects(
    options,
    dropped,
    (inline && wranglerWorkerName(inline, env)) ?? fileWorkerName,
  );
  warnDroppedWranglerOptions(dropped);
  return {
    options,
    configFile: fileLoaded ? configPath : undefined,
  };
}

// Whether the "`wranglerEnvFiles` ignored by the minimal reader" warning was shown.
let _warnedMinimalEnvFiles = false;

// Config file versions (path + env + mtime/size) whose wrangler warnings were
// already shown in this process.
const _shownWranglerWarnings = new Set<string>();

/** Show wrangler's config warnings once per file version + env, not on every reload. */
function claimWranglerWarnings(configPath: string, env: string | undefined): boolean {
  let version = "";
  try {
    const stat = statSync(configPath);
    version = `${stat.mtimeMs}:${stat.size}`;
  } catch {}
  const key = JSON.stringify([resolve(configPath), env ?? null, version]);
  if (_shownWranglerWarnings.has(key)) {
    return false;
  }
  _shownWranglerWarnings.add(key);
  return true;
}

function warnWranglerLoadError(desc: string, error: unknown): void {
  console.warn(`[env-runner] failed to load wrangler config ${desc}: ${(error as Error).message}`);
}

/** Merge file + inline options: `override` wins per key, records merge, arrays union. */
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
 * The inline read loads `.dev.vars` itself and would re-add keys the file read
 * excluded (undeclared under `secrets`, or taken by another binding type).
 */
function filterInlineDevVarBindings(
  inlineOptions: Record<string, unknown>,
  fileOptions: Record<string, unknown> | undefined,
  inlineConfig: { vars?: Record<string, unknown>; secrets?: { required?: string[] } },
): void {
  if (!isPlainObject(inlineOptions.bindings)) {
    return;
  }
  const fileBindings = isPlainObject(fileOptions?.bindings) ? fileOptions.bindings : {};
  const declared = new Set([
    ...Object.keys(inlineConfig.vars ?? {}),
    ...(inlineConfig.secrets?.required ?? []),
  ]);
  inlineOptions.bindings = Object.fromEntries(
    Object.entries(inlineOptions.bindings).filter(
      ([key]) => declared.has(key) || Object.hasOwn(fileBindings, key),
    ),
  );
}

/**
 * `readConfig` is file-based, so write the inline config to a temp file
 * (relative module/blob paths resolve into the temp dir).
 */
function readInlineWranglerConfig(wrangler: any, inline: WranglerInlineConfig, env?: string): any {
  const dir = mkdtempSync(join(tmpdir(), "env-runner-wrangler-"));
  const file = join(dir, "wrangler.json");
  try {
    writeFileSync(file, JSON.stringify(inline));
    // Hide warnings: they'd name the temp file and repeat on every load.
    return wrangler.unstable_readConfig({ config: file, env }, { hideWarnings: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Ancestor-dir configs already announced (see `findWranglerConfig`).
const _announcedWranglerConfigs = new Set<string>();

/**
 * Nearest directory wins (unlike wrangler, which tries each filename all the
 * way up). An entry outside cwd (e.g. under `node_modules/.pnpm`) checks only
 * its own dir before walking up from cwd, so its ancestors never beat cwd.
 */
function findWranglerConfig(entryPath?: string): string | undefined {
  const cwd = process.cwd();
  let start = cwd;
  if (entryPath) {
    const entryDir = dirname(resolve(entryPath));
    const rel = relative(cwd, entryDir);
    const insideCwd =
      rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (insideCwd) {
      start = entryDir;
    } else {
      const local = findWranglerConfigInDir(entryDir);
      if (local) {
        return local;
      }
    }
  }
  for (let dir = start; ; dir = dirname(dir)) {
    const found = findWranglerConfigInDir(dir);
    if (found) {
      if (dir !== cwd && dir !== start && !_announcedWranglerConfigs.has(found)) {
        _announcedWranglerConfigs.add(found);
        console.info(`[env-runner] using wrangler config from a parent directory: ${found}`);
      }
      return found;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** First existing `wrangler.{json,jsonc,toml}` directly in `dir`. */
function findWranglerConfigInDir(dir: string): string | undefined {
  for (const name of WRANGLER_CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Durable Objects are filtered after the file + inline merge (`filterLocalDurableObjects()`). */
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
    if (isEmptyPickedOption(key, value)) {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Keeps inline placeholders (wrangler always returns `email: { send_email: [] }`)
 * from replacing file values. `{}` values are real (`workerLoaders`), and a
 * `bindings` var may be `[]`.
 */
function isEmptyPickedOption(key: string, value: unknown): boolean {
  const isEmptyArray = (v: unknown) => Array.isArray(v) && v.length === 0;
  if (isEmptyArray(value) || (isPlainObject(value) && Object.keys(value).length === 0)) {
    return true;
  }
  return key !== "bindings" && isPlainObject(value) && Object.values(value).every(isEmptyArray);
}

/** Whether a wrangler-derived option value is empty (`{}`/`[]`/falsy). */
function isEmptyOption(value: unknown): boolean {
  return (
    !value ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

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
 * Drop Durable Object bindings to other scripts (workerd won't start). A
 * `scriptName` equal to `workerName` is local, as in `wrangler dev`, so it is
 * stripped (the runner's worker has its own name).
 */
function filterLocalDurableObjects(
  options: Record<string, unknown> | undefined,
  dropped: DroppedWranglerOptions,
  workerName?: string,
): void {
  const value = options?.durableObjects;
  if (!options || !isPlainObject(value)) {
    return;
  }
  const out: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(value)) {
    if (typeof binding === "string" || (isPlainObject(binding) && !binding.scriptName)) {
      out[name] = binding;
    } else if (isPlainObject(binding) && workerName && binding.scriptName === workerName) {
      const { scriptName: _scriptName, ...local } = binding;
      out[name] = local;
    } else {
      const scriptName = isPlainObject(binding) ? binding.scriptName : undefined;
      addDropped(dropped, "durable_objects", [`${name} → script "${String(scriptName)}"`]);
    }
  }
  if (Object.keys(out).length > 0) {
    options.durableObjects = out;
  } else {
    delete options.durableObjects;
  }
}

/** Fallback without the `wrangler` package: plain JSON, common fields only. */
function readWranglerConfigMinimal(
  configPath: string,
  env: string | undefined,
  dropped: DroppedWranglerOptions,
  meta: { workerName?: string } = {},
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
  meta.workerName = wranglerWorkerName(config, env);
  // `{}` (not undefined) marks the file as loaded even without mapped fields.
  return mapWranglerConfigToMiniflare(applyWranglerEnv(config, env), dropped) ?? {};
}

/** Shallow `--env` override (wrangler doesn't inherit bindings into envs). */
function applyWranglerEnv(config: Record<string, any>, env?: string): Record<string, any> {
  return env && config.env?.[env] ? { ...config, ...config.env[env] } : config;
}

/**
 * Like wrangler: the env's `name`, else top-level `name` + `-<env>` (even
 * without that env section).
 */
function wranglerWorkerName(config: Record<string, any>, env?: string): string | undefined {
  const envName = env ? config.env?.[env]?.name : undefined;
  if (typeof envName === "string") return envName;
  if (typeof config.name !== "string" || !config.name) return undefined;
  return env ? `${config.name}-${env}` : config.name;
}

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
      // Bindings with a `script_name` keep it for `filterLocalDurableObjects()`,
      // which runs after the file + inline merge.
      if (!b?.name || !b?.class_name) continue;
      dos[b.name] = b.script_name
        ? { className: b.class_name, scriptName: b.script_name }
        : b.class_name;
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
