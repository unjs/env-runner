import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** Raw (snake_case) Wrangler config object, mirroring `wrangler.json` contents. */
export type WranglerInlineConfig = Record<string, unknown>;

// One-time warning when `wrangler` is requested but not installed.
let _warnedNoWrangler = false;

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
  // Adopting wrangler's rules would defeat that injection (mirrors
  // @cloudflare/vite-plugin, which also strips `modulesRules`).
  "modulesRules",
  "unsafeDirectSockets",
  "unsafeEvalBinding",
  "unsafeModuleFallbackService",
  "unsafeUseModuleFallbackService",
]);

/** Whether a value is a plain (non-array, non-null) object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a `wrangler` option value is an inline raw config object. */
function isInlineWranglerConfig(opt: unknown): opt is WranglerInlineConfig {
  return isPlainObject(opt);
}

/**
 * Resolve the optional wrangler config into a partial Miniflare options
 * object (compat date/flags + bindings). Accepts a file path, auto-discovery
 * (`true`), or an inline raw config object. When an inline config is passed,
 * a config file is still auto-discovered (next to the entry, then cwd) and
 * loaded — the inline config is merged on top of it (inline wins per key,
 * binding records merge, `compatibilityFlags` are unioned). Prefers the
 * installed `wrangler` package; falls back to a built-in minimal JSON reader
 * (with a one-time warning) when it isn't available. Returns `undefined`
 * when `wrangler` is disabled or no config could be loaded.
 */
export async function loadWranglerConfig(
  opt: boolean | string | WranglerInlineConfig,
  env: string | undefined,
  entryPath?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!opt) {
    return undefined;
  }
  const inline = isInlineWranglerConfig(opt) ? opt : undefined;

  // Resolve a config file: an explicit string path, or auto-discovery for
  // both `true` and inline objects (an inline config is merged on top of any
  // discovered file). A missing explicit/auto-discovered file warns, but a
  // missing file is fine for an inline config (the inline config is enough).
  let configPath: string | undefined;
  if (typeof opt === "string") {
    configPath = resolve(opt);
    if (!existsSync(configPath)) {
      console.warn(`[env-runner] wrangler config requested but not found at "${configPath}"`);
      return undefined;
    }
  } else if (opt === true) {
    configPath = findWranglerConfig(entryPath);
    if (!configPath) {
      console.warn("[env-runner] wrangler config requested but none found near the entry or cwd");
      return undefined;
    }
  } else {
    // Inline object — augment with an auto-discovered file when present.
    configPath = findWranglerConfig(entryPath);
  }

  // Prefer the real `wrangler` package for full fidelity (TOML, env
  // inheritance, .dev.vars, every binding type). An inline config is
  // normalized through a short-lived temp file (readConfig is file-based).
  let wrangler: any;
  try {
    wrangler = await import("wrangler");
  } catch {
    if (!_warnedNoWrangler) {
      _warnedNoWrangler = true;
      console.warn(
        "[env-runner] 'wrangler' is not installed; using the built-in minimal config reader " +
          "(plain JSON, common fields only). Install 'wrangler' for full fidelity " +
          "(JSONC, TOML, env inheritance, all binding types).",
      );
    }
    const fileOptions = configPath ? readWranglerConfigMinimal(configPath, env) : undefined;
    const inlineOptions = inline
      ? mapWranglerConfigToMiniflare(applyWranglerEnv(inline, env))
      : undefined;
    return mergeWranglerMiniflareOptions(fileOptions, inlineOptions);
  }

  try {
    const fileOptions = configPath
      ? pickWranglerMiniflareOptions(
          wrangler.unstable_getMiniflareWorkerOptions(
            wrangler.unstable_readConfig({ config: configPath, env }, { hideWarnings: true }),
            env,
          ).workerOptions,
        )
      : undefined;
    const inlineOptions = inline
      ? pickWranglerMiniflareOptions(
          wrangler.unstable_getMiniflareWorkerOptions(
            readInlineWranglerConfig(wrangler, inline, env),
            env,
          ).workerOptions,
        )
      : undefined;
    return mergeWranglerMiniflareOptions(fileOptions, inlineOptions);
  } catch (error) {
    const desc = [configPath && `"${configPath}"`, inline && "(inline)"]
      .filter(Boolean)
      .join(" + ");
    console.warn(
      `[env-runner] failed to load wrangler config ${desc}: ${(error as Error).message}`,
    );
    return undefined;
  }
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
 * direct sockets, etc.). The returned object is spread under `miniflareOptions`.
 */
function pickWranglerMiniflareOptions(
  workerOptions: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workerOptions)) {
    if (value === undefined || WRANGLER_OPTION_DENYLIST.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Minimal wrangler-config reader used when the `wrangler` package is absent.
 * Parses plain JSON only and maps the common fields to Miniflare options.
 * JSONC and TOML files need the `wrangler` package and are skipped with a
 * warning.
 */
function readWranglerConfigMinimal(
  configPath: string,
  env?: string,
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
  return mapWranglerConfigToMiniflare(applyWranglerEnv(config, env));
}

/**
 * Shallow `--env` override of the selected fields. Real wrangler inheritance is
 * more nuanced (bindings are not inherited into named environments), but this
 * covers the common case for the minimal fallback path.
 */
function applyWranglerEnv(config: Record<string, any>, env?: string): Record<string, any> {
  return env && config.env?.[env] ? { ...config, ...config.env[env] } : config;
}

/** Map raw (snake_case) wrangler config fields to Miniflare option shapes. */
function mapWranglerConfigToMiniflare(
  config: Record<string, any>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
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
