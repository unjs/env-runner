import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";
import { loadDevVars } from "./dotenv.ts";

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
    const unsupported: DroppedWranglerOptions = new Map();
    const file = configPath ? readWranglerConfigMinimal(configPath, env) : undefined;
    const inlineConfig = inline ? applyWranglerEnv(inline, env) : undefined;
    // `{}` (not undefined) marks the file as loaded even without mapped fields.
    const fileOptions =
      file && (mapWranglerConfigToMiniflare(file.config, dropped, unsupported) ?? {});
    const inlineOptions =
      inlineConfig && mapWranglerConfigToMiniflare(inlineConfig, dropped, unsupported);
    let options = mergeWranglerMiniflareOptions(fileOptions, inlineOptions);
    if (file || inlineConfig) {
      options = applyMinimalDevVars(options, [file?.config, inlineConfig], {
        // Like the package path: the config file's dir (even if unparsable), else cwd.
        configDir: configPath ? dirname(configPath) : process.cwd(),
        env,
        envFiles,
      });
    }
    filterLocalDurableObjects(
      options,
      dropped,
      (inline && wranglerWorkerName(inline, env)) ?? file?.workerName,
    );
    warnDroppedWranglerOptions(dropped);
    warnUnsupportedMinimalBindings(unsupported);
    return {
      options,
      // `readWranglerConfigMinimal` returns undefined for skipped/unparsable files.
      configFile: file ? configPath : undefined,
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

// Fields wrangler does not inherit from the top level into a named env
// (`notInheritable` in wrangler's `normalizeAndValidateEnvironment`).
const WRANGLER_NON_INHERITABLE_KEYS = new Set([
  "vars",
  "secrets",
  "define",
  "durable_objects",
  "workflows",
  "kv_namespaces",
  "cloudchamber",
  "containers",
  "send_email",
  "queues",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "websearch",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "tail_consumers",
  "streaming_tail_consumers",
  "unsafe",
  "browser",
  "ai",
  "images",
  "stream",
  "media",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "ratelimits",
  "vpc_services",
  "vpc_networks",
  "version_metadata",
]);

// Binding config keys the minimal reader doesn't map (warned about).
const MINIMAL_UNSUPPORTED_BINDING_KEYS = [
  "hyperdrive",
  "analytics_engine_datasets",
  "ai",
  "ai_search_namespaces",
  "ai_search",
  "websearch",
  "agent_memory",
  "version_metadata",
  "ratelimits",
  "send_email",
  "secrets_store_secrets",
  "vectorize",
  "browser",
  "images",
  "stream",
  "media",
  "pipelines",
  "dispatch_namespaces",
  "mtls_certificates",
  "worker_loaders",
  "vpc_services",
  "vpc_networks",
  "artifacts",
  "flagship",
  "containers",
  "unsafe",
  "unsafe_hello_world",
  "logfwdr",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
];

// Miniflare options holding non-var bindings mapped by the minimal reader
// (dev vars never replace them, like wrangler's `getBindings`).
const MINIMAL_BINDING_OPTIONS = [
  "kvNamespaces",
  "r2Buckets",
  "d1Databases",
  "queueProducers",
  "durableObjects",
];

function warnUnsupportedMinimalBindings(unsupported: DroppedWranglerOptions): void {
  if (unsupported.size === 0) {
    return;
  }
  const list = [...unsupported]
    .map(([name, details]) => (details.size > 0 ? `${name} (${[...details].join(", ")})` : name))
    .join(", ");
  console.warn(
    `[env-runner] wrangler config bindings not supported by the built-in minimal wrangler config reader were ignored: ${list}; install 'wrangler' (or pass it as \`wranglerModule\`) to use them.`,
  );
}

/** Fallback without the `wrangler` package: JSON/JSONC, common fields only. */
function readWranglerConfigMinimal(
  configPath: string,
  env: string | undefined,
): { config: Record<string, any>; workerName?: string } | undefined {
  const ext = extname(configPath).toLowerCase();
  if (ext !== ".json" && ext !== ".jsonc") {
    console.warn(
      `[env-runner] reading "${basename(configPath)}" requires the 'wrangler' package; the built-in reader supports JSON/JSONC only (install 'wrangler' for TOML).`,
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
    // Wrangler parses both `.json` and `.jsonc` as JSONC.
    config = parseJSONC(raw);
  } catch (error) {
    console.warn(
      `[env-runner] failed to parse wrangler config "${configPath}": ${(error as Error).message}`,
    );
    return undefined;
  }
  if (!isPlainObject(config)) {
    warnWranglerLoadError(`"${configPath}"`, new Error("config must be an object"));
    return undefined;
  }
  let envConfig: Record<string, any>;
  try {
    envConfig = applyWranglerEnv(config, env, configPath);
  } catch (error) {
    warnWranglerLoadError(`"${configPath}"`, error);
    return undefined;
  }
  return { config: envConfig, workerName: wranglerWorkerName(config, env) };
}

/**
 * Select `--env` like wrangler: inheritable fields (compatibility, migrations,
 * ...) fall back to the top level, bindings/vars don't. A file config (with
 * `configPath`) throws for an env missing from a defined `env` map and warns
 * (once per file version) about top-level fields the env doesn't inherit; an
 * inline config lacking the env uses its top level as-is.
 */
function applyWranglerEnv(
  config: Record<string, any>,
  env?: string,
  configPath?: string,
): Record<string, any> {
  const { env: envs, ...topLevel } = config;
  if (!env) {
    return topLevel;
  }
  const rawEnv = isPlainObject(envs) ? envs[env] : undefined;
  const warnings: string[] = [];
  let out: Record<string, any>;
  if (isPlainObject(rawEnv)) {
    out = {};
    for (const [key, value] of Object.entries(topLevel)) {
      if (!WRANGLER_NON_INHERITABLE_KEYS.has(key)) {
        out[key] = value;
      } else if (rawEnv[key] === undefined) {
        warnings.push(`"${key}" exists at the top level, but is not inherited by "env.${env}"`);
      }
    }
    Object.assign(out, rawEnv);
  } else {
    if (configPath && isPlainObject(envs)) {
      throw new Error(
        `No environment found in configuration with name "${env}". The available configured environment names are: ${JSON.stringify(Object.keys(envs))}`,
      );
    }
    warnings.push(`No environment found in configuration with name "${env}"`);
    out = topLevel;
  }
  if (configPath && warnings.length > 0 && claimWranglerWarnings(configPath, env)) {
    console.warn(`[env-runner] wrangler config "${configPath}": ${warnings.join("; ")}.`);
  }
  return out;
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
  unsupported: DroppedWranglerOptions,
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
  for (const key of MINIMAL_UNSUPPORTED_BINDING_KEYS) {
    const value = config[key];
    const bindings = isPlainObject(value) && Array.isArray(value.bindings) ? value.bindings : value;
    if (!isEmptyOption(bindings)) {
      addDropped(unsupported, key, describeBindingNames(bindings));
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
  // Local ids prefer preview ids, like `wrangler dev` (so persisted state is shared).
  const kv = mapBindingArray(config.kv_namespaces, "binding", (n) =>
    firstString(n.preview_id, n.id, n.binding),
  );
  if (kv) out.kvNamespaces = kv;
  const r2 = mapBindingArray(config.r2_buckets, "binding", (n) =>
    firstString(n.preview_bucket_name, n.bucket_name, n.binding),
  );
  if (r2) out.r2Buckets = r2;
  const d1 = mapBindingArray(config.d1_databases, "binding", (n) =>
    firstString(n.preview_database_id, n.database_id, n.binding),
  );
  if (d1) out.d1Databases = d1;
  const queues = mapBindingArray(config.queues?.producers, "binding", (n) => n.queue);
  if (queues) out.queueProducers = queues;
  const useSQLite = durableObjectClassStorage(config);
  const doBindings: any[] = Array.isArray(config.durable_objects?.bindings)
    ? config.durable_objects.bindings
    : [];
  const dos: Record<string, unknown> = {};
  for (const b of doBindings) {
    // Bindings with a `script_name` keep it for `filterLocalDurableObjects()`,
    // which runs after the file + inline merge.
    if (!b?.name || !b?.class_name) continue;
    dos[b.name] = {
      className: b.class_name,
      ...(b.script_name ? { scriptName: b.script_name } : {}),
      ...(useSQLite.has(b.class_name) ? { useSQLite: useSQLite.get(b.class_name) } : {}),
    };
  }
  if (Object.keys(dos).length > 0) out.durableObjects = dos;
  // Migrated classes without a binding still need their storage backend.
  const unbound = [...useSQLite]
    .filter(([className]) => !doBindings.some((b) => b?.class_name === className))
    .map(([className, sqlite]) => ({ className, useSQLite: sqlite }));
  if (unbound.length > 0) out.additionalUnboundDurableObjects = unbound;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Durable Object class → `useSQLite`, from `migrations` and `exports` (like
 * wrangler's `getDurableObjectClassNameToUseSQLiteMap`, minus its errors).
 */
function durableObjectClassStorage(config: Record<string, any>): Map<string, boolean> {
  const classes = new Map<string, boolean>();
  for (const migration of Array.isArray(config.migrations) ? config.migrations : []) {
    for (const name of migration?.deleted_classes ?? []) {
      classes.delete(name);
    }
    for (const { from, to } of migration?.renamed_classes ?? []) {
      const sqlite = classes.get(from);
      if (sqlite !== undefined) {
        classes.delete(from);
        classes.set(to, sqlite);
      }
    }
    for (const name of migration?.new_classes ?? []) {
      classes.set(name, false);
    }
    for (const name of migration?.new_sqlite_classes ?? []) {
      classes.set(name, true);
    }
  }
  if (isPlainObject(config.exports)) {
    for (const [name, entry] of Object.entries<any>(config.exports)) {
      const state = entry?.state;
      if (
        entry?.type === "durable-object" &&
        (state === undefined || state === "created" || state === "expecting-transfer")
      ) {
        classes.set(name, entry.storage === "sqlite");
      }
    }
  }
  return classes;
}

/** Binding names of a wrangler binding config (list, single object, or record). */
function describeBindingNames(value: unknown): string[] {
  if (isPlainObject(value) && typeof value.binding !== "string") {
    return Object.keys(value);
  }
  const entries: any[] = Array.isArray(value) ? value : [value];
  return entries
    .map((e) => e?.binding ?? e?.name ?? e?.class_name)
    .filter((name) => typeof name === "string");
}

/**
 * Overlay local dev vars (`.dev.vars` / `.env*`) on `vars`, like wrangler's
 * `getVarsForDev`. With `secrets` declared (by either config) only declared
 * vars/secrets are taken; names of other bindings are never replaced.
 */
function applyMinimalDevVars(
  options: Record<string, unknown> | undefined,
  configs: (Record<string, any> | undefined)[],
  opts: { configDir: string; env?: string; envFiles?: string[] },
): Record<string, unknown> | undefined {
  const secrets = configs.map((c) => c?.secrets).filter(isPlainObject);
  const loaded = loadDevVars({ ...opts, hasSecrets: secrets.length > 0 });
  if (!loaded) {
    return options;
  }
  const out = { ...options };
  const bindings: Record<string, unknown> = isPlainObject(out.bindings) ? { ...out.bindings } : {};
  const taken = new Set(
    MINIMAL_BINDING_OPTIONS.flatMap((key) =>
      isPlainObject(out[key]) ? Object.keys(out[key]) : [],
    ),
  );
  const required = new Set(
    secrets.flatMap((s) => (Array.isArray(s.required) ? (s.required as string[]) : [])),
  );
  let changed = false;
  for (const [key, value] of Object.entries(loaded)) {
    if (
      taken.has(key) ||
      (secrets.length > 0 && !Object.hasOwn(bindings, key) && !required.has(key))
    ) {
      continue;
    }
    bindings[key] = value;
    changed = true;
  }
  const missing = [...required].filter((key) => !Object.hasOwn(loaded, key));
  if (missing.length > 0) {
    console.warn(
      `[env-runner] missing required wrangler secrets: ${missing.join(", ")}. Add them to .dev.vars, .env, or set as environment variables.`,
    );
  }
  if (!changed) {
    return options;
  }
  out.bindings = bindings;
  return out;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

/**
 * Parse JSON with comments and trailing commas (what wrangler accepts for
 * `wrangler.json`/`wrangler.jsonc`). Stripped characters become spaces so
 * error positions stay accurate.
 */
export function parseJSONC(text: string): any {
  let out = "";
  let comma = -1;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const line = src[i + 1] === "/";
      let end = line ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      end = end === -1 ? src.length : line ? end : end + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      out += ch;
      continue;
    }
    if ((ch === "}" || ch === "]") && comma !== -1) {
      out = `${out.slice(0, comma)} ${out.slice(comma + 1)}`;
    }
    comma = -1;
    if (ch === '"') {
      let end = i + 1;
      while (end < src.length && src[end] !== '"') {
        end += src[end] === "\\" ? 2 : 1;
      }
      out += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === ",") {
      comma = out.length;
    }
    out += ch;
  }
  return JSON.parse(out);
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
