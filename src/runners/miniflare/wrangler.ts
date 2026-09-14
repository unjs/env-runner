import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /**
   * Custom `.env` files for local dev vars/secrets, forwarded to wrangler's
   * `unstable_getMiniflareWorkerOptions(config, env, { envFiles })`. Paths
   * resolve against the config file's directory; when non-empty, `.dev.vars`
   * is not read (`[]` reads `.dev.vars` but no `.env*`). Only used by the
   * `wrangler` package path (the minimal reader warns once when it is set).
   */
  envFiles?: string[];
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
 * otherwise a file is auto-discovered (see `findWranglerConfig()`). An inline
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
  const { wrangler: opt, env, entryPath, wranglerModule, envFiles } = opts;
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
      console.warn(
        "[env-runner] wrangler config requested but none found (searched the entry's directory, then from the cwd up to the filesystem root)",
      );
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
      // Surface wrangler's config warnings (unexpected/misspelled keys, an
      // `--env` missing from the config, ...) once per file version + env
      // instead of on every re-init/hot reload.
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
      // `readConfig` throws for an `--env` missing from the config's `env`
      // map, while the file may define it. Like `applyWranglerEnv()`, use the
      // inline top level as-is when it doesn't define the selected env.
      const inlineEnv = env && isPlainObject(inline.env) && inline.env[env] ? env : undefined;
      const { env: _env, ...inlineTopLevel } = inline;
      const inlineConfig = readInlineWranglerConfig(
        wrangler,
        inlineEnv ? inline : inlineTopLevel,
        inlineEnv,
      );
      // wrangler resolves `.dev.vars[.<env>]` / `.env*` against the dir of
      // `userConfigPath` (else cwd) — the deleted temp dir for an inline
      // config. Anchor it to the project instead: the config file (set only
      // when it exists), else cwd (`undefined`). Loading them here also keeps
      // inline `vars` from overriding the file's dev-var secrets in the
      // merge, since `.dev.vars` values win over `vars` within each read.
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

/**
 * Whether wrangler's config warnings should be shown for this read: `true`
 * the first time a given config file version is read with a given env in this
 * process, so re-inits and hot reloads don't repeat them (editing the file
 * shows them again).
 */
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
 * Keep only inline `bindings` the inline config declares (`vars`,
 * `secrets.required`) or the file read already produced. The inline read loads
 * the project's dev vars on its own, so it would otherwise add `.dev.vars`
 * keys the file read excluded — undeclared under explicit `secrets`, or names
 * taken by another binding type (e.g. a KV namespace).
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
 * Normalize an inline raw config through the `wrangler` package. `readConfig`
 * is file-based, so the object is written to a short-lived temp file (env-runner
 * ignores the config's `main`; relative module/blob paths do resolve into the
 * temp dir). Returns the normalized wrangler `Config`, whose `userConfigPath`
 * the caller re-anchors to the project for the dev-vars lookup.
 */
function readInlineWranglerConfig(wrangler: any, inline: WranglerInlineConfig, env?: string): any {
  const dir = mkdtempSync(join(tmpdir(), "env-runner-wrangler-"));
  const file = join(dir, "wrangler.json");
  try {
    writeFileSync(file, JSON.stringify(inline));
    // Warnings stay hidden: wrangler would attribute them to this throwaway
    // temp file ("Processing ../../tmp/env-runner-wrangler-*/wrangler.json
    // configuration"), and inline configs are programmatic and re-normalized
    // on every load. Validation errors still throw (warned as `(inline)`).
    return wrangler.unstable_readConfig({ config: file, env }, { hideWarnings: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Ancestor-dir configs already announced (see `findWranglerConfig`).
const _announcedWranglerConfigs = new Set<string>();

/**
 * Discover a wrangler config. When the entry's directory is inside the cwd,
 * walk up from the entry's directory to the filesystem root (passing through
 * the cwd). Otherwise — e.g. a framework entry hoisted under
 * `node_modules/.pnpm` or a sibling package — only the entry's own directory
 * is checked, then walk up from the cwd, so an ancestor of an out-of-cwd entry
 * never beats the cwd's own config. The nearest directory wins; within a
 * directory `wrangler.json` > `wrangler.jsonc` > `wrangler.toml` (wrangler's
 * `findWranglerConfig` instead searches for each filename all the way up
 * before trying the next). A config found above the entry dir/cwd is
 * announced once with `console.info`.
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

/**
 * Keep the binding/compat fields from wrangler's `unstable_getMiniflareWorkerOptions`
 * output, dropping keys the runner manages (entry script, module fallback,
 * direct sockets, etc.), options a single dev worker can't run (service
 * bindings, assets, queue consumers, workflows, tails), and empty
 * records/arrays. Non-empty dropped options are recorded in `dropped` for the
 * load warning. Durable Object bindings are kept as-is here and filtered after
 * the file + inline merge (`filterLocalDurableObjects()`). The returned object
 * is spread under `miniflareOptions`.
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
    if (isEmptyPickedOption(key, value)) {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether a picked wrangler-derived option carries nothing: `{}`/`[]`, or a
 * wrapper object whose values are all `[]` (wrangler always returns
 * `email: { send_email: [] }`). Dropping these keeps an inline config's
 * placeholders from replacing a file's populated values in the shallow
 * record merge. `{}` values don't count (a `workerLoaders` binding is `{}`),
 * and `bindings` holds user `vars` (a JSON var may be `[]`), so only a fully
 * empty record counts there.
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
 * In the merged wrangler-derived `options`, keep Durable Object bindings served
 * by this worker (a class name string, or an object without `scriptName`);
 * bindings to another script's class can't resolve in a single-worker
 * Miniflare and would stop workerd from starting (recorded in `dropped`). A
 * `scriptName` equal to the effective worker name (`workerName`: the inline
 * config's `name` when set, else the file's) refers to this worker (local in
 * `wrangler dev`), so it is stripped and the binding kept — the runner's
 * worker has its own name. Mutates `options`; an emptied record is removed.
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

/**
 * Shallow `--env` override of the selected fields. Real wrangler inheritance is
 * more nuanced (bindings are not inherited into named environments), but this
 * covers the common case for the minimal fallback path.
 */
function applyWranglerEnv(config: Record<string, any>, env?: string): Record<string, any> {
  return env && config.env?.[env] ? { ...config, ...config.env[env] } : config;
}

/**
 * Worker name of a raw config for `--env`, following wrangler's normalization
 * (`inheritable(..., appendEnvName(env))`): with an env selected, the env
 * section's own `name` wins, else the top-level `name` suffixed with `-<env>`
 * — even when the config has no such env section (wrangler warns but still
 * suffixes). Used to recognize Durable Object bindings whose `script_name`
 * points at this worker.
 */
function wranglerWorkerName(config: Record<string, any>, env?: string): string | undefined {
  const envName = env ? config.env?.[env]?.name : undefined;
  if (typeof envName === "string") return envName;
  if (typeof config.name !== "string" || !config.name) return undefined;
  return env ? `${config.name}-${env}` : config.name;
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
