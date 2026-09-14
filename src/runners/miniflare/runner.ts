import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModulePath } from "exsolve";
import { init as initCjsLexer, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { proxyUpgrade } from "httpxy";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import { isVirtualSpecifier } from "../../common/worker-utils.ts";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";
import {
  expandVirtualInvalidation,
  stripVirtualTypeScript,
  virtualModuleFormat,
} from "../../virtual-loader.ts";
import { generateWrapper, IPC_BINDING, UNSAFE_EVAL_BINDING } from "./wrapper.ts";
import { isPlainObject, loadWranglerConfig } from "./wrangler.ts";
import type { WranglerInlineConfig, WranglerModule } from "./wrangler.ts";

export type { WranglerInlineConfig, WranglerModule } from "./wrangler.ts";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export type { EnvRunnerData as MiniflareEnvRunnerData } from "../../common/base-runner.ts";

/** Result from a module transform (compatible with Vite's `TransformResult`). */
export interface TransformResult {
  code: string;
}

/** Detected or declared export for auto-wiring Durable Object / Entrypoint bindings. */
export interface MiniflareExportInfo {
  type?: "DurableObject" | "WorkerEntrypoint" | "class";
}

/**
 * The `miniflare` package, as imported by the consumer.
 *
 * `miniflare` is not a dependency of `env-runner` — pass the module namespace
 * (`import * as miniflare from "miniflare"`) so the dependency stays owned by
 * the application. The runner only falls back to importing it itself when this
 * is omitted.
 */
export interface MiniflareModule {
  Miniflare: new (options: any) => any;
  /**
   * Newest compatibility date supported by the installed `workerd` binary,
   * clamped to today. Used as the default `compatibilityDate`.
   */
  supportedCompatibilityDate?: string;
  [key: string]: unknown;
}

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /**
   * The `miniflare` package: the imported module, or a specifier for it.
   *
   * ```ts
   * import * as miniflare from "miniflare";
   * new MiniflareEnvRunner({ name: "app", miniflare, data: { entry } });
   *
   * // or, equivalently
   * new MiniflareEnvRunner({ name: "app", miniflare: "miniflare", data: { entry } });
   * ```
   *
   * Passing it explicitly is preferred (`miniflare` is not a dependency of
   * `env-runner`, so the version you install is the version that runs). Bare
   * specifiers resolve from the current working directory. When omitted, the
   * runner falls back to importing `miniflare` itself and only fails if that
   * is unavailable too.
   */
  miniflare?: RuntimeDep<MiniflareModule>;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
  /**
   * Compatibility date for the worker. The special value `"latest"` uses the
   * newest date supported by the installed `workerd` (miniflare's
   * `supportedCompatibilityDate`), so callers don't need to import miniflare
   * themselves.
   *
   * Overrides the {@link MiniflareEnvRunnerOptions.wrangler} config's
   * `compatibility_date`; `miniflareOptions.compatibilityDate` still wins.
   * When unset, the wrangler date is used if present, else the supported
   * date. Whatever the source, a date newer than the installed `workerd`
   * supports falls back to the supported date with a warning (like
   * `wrangler dev`), since workerd refuses to start with it.
   */
  compatibilityDate?: "latest" | (string & {});
  /**
   * Optional module transform callback. When provided, the module fallback
   * service calls this instead of reading raw files from disk.
   *
   * This enables integration with Vite's transform pipeline — pass
   * `environment.transformRequest` to get TS/JSX/etc. compiled on the fly.
   *
   * @param id - Absolute file path of the module to transform
   * @returns Transformed code, or null/undefined to fall back to raw disk read
   */
  transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  /**
   * Declare named exports (Durable Objects, WorkerEntrypoints) to auto-wire
   * bindings and generate re-exports in the wrapper module.
   *
   * When set to `true`, `export class` declarations are auto-detected from
   * the entry file. When set to a record, the listed exports are used
   * (merged with auto-detected ones). Disabled by default.
   */
  exports?: Record<string, MiniflareExportInfo> | boolean;
  /**
   * When `true`, the Miniflare instance is cached and reused across runner
   * swaps (e.g. via `RunnerManager.reload()`). `close()` tears down IPC but
   * keeps Miniflare alive. Call `dispose()` to fully destroy it.
   */
  persistent?: boolean;
  /** Wrap the user's `fetch` in a try/catch that returns structured JSON error responses. Default: `true`. */
  captureErrors?: boolean;
  /**
   * Export conditions for bare-specifier module resolution in the module
   * fallback service. Ensures packages with conditional exports (e.g.
   * `"workerd"`) resolve to the correct entry instead of the Node.js one.
   *
   * Defaults to `["workerd", "worker"]`.
   */
  exportConditions?: string[];
  /**
   * Load a Cloudflare `wrangler` config to populate Miniflare options
   * (compatibility date/flags and bindings: `vars`, KV, R2, D1, Durable
   * Objects, queues).
   *
   * - `true` — auto-discover `wrangler.{json,jsonc,toml}`: when the entry
   *   file is inside the current working directory, walk up from the entry's
   *   directory to the filesystem root; otherwise (e.g. an entry hoisted
   *   under `node_modules/.pnpm`) check only the entry's own directory, then
   *   walk up from the cwd. The nearest directory wins, and within a
   *   directory `wrangler.json` > `wrangler.jsonc` > `wrangler.toml` (wrangler
   *   itself tries each filename all the way up before the next). A config
   *   found above the entry dir/cwd is logged once.
   * - `string` — explicit path to a wrangler config file.
   * - `object` — an inline raw (snake_case) wrangler config, as you would
   *   write in `wrangler.json` (no file needed). A config file is still
   *   loaded ({@link MiniflareEnvRunnerOptions.wranglerConfigPath}, else
   *   auto-discovered as for `true`) and the inline config is
   *   merged on top of it (inline wins per key, binding records merge,
   *   `compatibilityFlags` are unioned). When the inline config doesn't
   *   define the selected {@link MiniflareEnvRunnerOptions.wranglerEnv}, its
   *   top level is used as-is. The file and inline configs load
   *   independently: one failing warns without discarding the other.
   *
   * Options a single fetch-only dev worker can't run are dropped from the
   * config with a single warning naming them: `assets`, service bindings,
   * queue consumers, workflows, tail consumers, and Durable Object bindings
   * to another script (`script_name`). Pass them via `miniflareOptions` to
   * opt in. A Durable Object binding whose `script_name` equals the effective
   * worker `name` — the inline config's `name` when set, else the file's,
   * suffixed `-<env>` when a {@link MiniflareEnvRunnerOptions.wranglerEnv} is
   * selected and its env section sets no `name` (e.g. `app-staging`) — is
   * local, as in `wrangler dev`, and kept.
   *
   * With the `wrangler` package, wrangler's own config warnings (unexpected
   * keys, an `--env` the config doesn't define, ...) are shown for a config
   * file once per file version and env per process, not on every reload.
   * Warnings for inline configs stay hidden. Like `wrangler dev`, wrangler
   * then also runs its npm update check for unexpected keys (cached for a
   * day; may print a "newer version of Wrangler" hint).
   *
   * Local state is shared with `wrangler dev`: `defaultPersistRoot` defaults
   * to `<dir>/.wrangler/state/v3`, where `<dir>` is the directory of the
   * loaded config file, else of the requested config path (`wrangler` string
   * or `wranglerConfigPath`, even if missing), else the current working
   * directory (e.g. inline-only configs). Skipped when `miniflareOptions` sets
   * `defaultPersistRoot` or any `*Persist` option.
   *
   * The `wrangler` package is used for full fidelity when available (TOML,
   * `env` inheritance, `.dev.vars`, every binding type; an inline config is
   * normalized through a short-lived temp file) — passed explicitly as
   * `wranglerModule`, or imported optionally. Otherwise a built-in minimal
   * reader handles plain JSON files and inline objects (common fields only);
   * JSONC and TOML files are skipped with a warning. Values from
   * `miniflareOptions` always win over config-derived ones; binding records
   * (e.g. `bindings`) merge per key and `compatibilityFlags` are unioned.
   */
  wrangler?: boolean | string | WranglerInlineConfig;
  /**
   * Explicit wrangler config file to load instead of auto-discovery when
   * {@link MiniflareEnvRunnerOptions.wrangler} is `true` or an inline object
   * (the inline config still merges on top). Relative paths resolve from the
   * current working directory. A missing file warns; with an inline config
   * the runner continues with the inline config only. Ignored when `wrangler`
   * is a string path (that path wins) or disabled.
   */
  wranglerConfigPath?: string;
  /**
   * Wrangler environment (`--env`) to select when loading the config.
   * Defaults to the `CLOUDFLARE_ENV` environment variable.
   */
  wranglerEnv?: string;
  /**
   * Custom `.env` files to load local dev vars/secrets from, like
   * `getPlatformProxy({ envFiles })` — forwarded to wrangler's
   * `unstable_getMiniflareWorkerOptions(config, env, { envFiles })`. Paths
   * resolve against the loaded config file's directory (else the current
   * working directory); later files override earlier ones. When non-empty,
   * `.dev.vars` is not read. When unset, wrangler's defaults apply
   * (`.dev.vars[.<env>]`, else `.env`, `.env.local`, `.env.<env>`,
   * `.env.<env>.local`). An empty array still reads `.dev.vars[.<env>]` but
   * no `.env*` files.
   *
   * Only applies when the `wrangler` package is used (see
   * {@link MiniflareEnvRunnerOptions.wranglerModule}); the built-in minimal
   * reader loads no dev-var files and warns once that the option is ignored.
   */
  wranglerEnvFiles?: string[];
  /**
   * The imported `wrangler` package (`import * as wrangler from "wrangler"`),
   * used to parse the {@link MiniflareEnvRunnerOptions.wrangler} config with
   * full fidelity. When omitted, `import("wrangler")` is tried, and a built-in
   * minimal reader (plain JSON configs and inline objects) handles the rest.
   *
   * Pass `false` to skip the `wrangler` package entirely and always use the
   * built-in minimal reader.
   */
  wranglerModule?: RuntimeDep<WranglerModule>;
}

const IPC_PATH = "/__env_runner_ipc";

interface MiniflareCacheEntry {
  mf: InstanceType<any>;
  refCount: number;
  // The instance's fallback-service closure serves these live maps; runners
  // attaching to the cached instance adopt them so `invalidateModule()`
  // mutates what the instance actually serves (see #initAsync).
  virtual?: Record<string, string>;
  versions: Map<string, number>;
}

// Module-level cache for persistent Miniflare instances
const _miniflareCache = new Map<string, MiniflareCacheEntry>();

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  #reloadCounter = 0;
  #virtual?: Record<string, string>;
  #virtualVersions = new Map<string, number>();
  #cacheEntry?: MiniflareCacheEntry;
  #ws?: { send(data: string): void; close(): void };
  #persistent: boolean;
  #cacheKey?: string;
  #exports: Record<string, MiniflareExportInfo> | boolean;
  #captureErrors: boolean;
  #exportConditions: string[];
  #wrangler: boolean | string | WranglerInlineConfig;
  #wranglerEnv?: string;
  #wranglerConfigPath?: string;
  #wranglerEnvFiles?: string[];
  #compatibilityDate?: string;
  #wranglerModule?: RuntimeDep<WranglerModule>;
  #miniflareModule?: RuntimeDep<MiniflareModule>;

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareModule = opts.miniflare;
    this.#miniflareOptions = opts.miniflareOptions || {};
    this.#transformRequest = opts.transformRequest;
    this.#persistent = opts.persistent ?? false;
    this.#exports = opts.exports ?? {};
    this.#captureErrors = opts.captureErrors ?? true;
    this.#exportConditions = opts.exportConditions ?? ["workerd", "worker"];
    this.#wrangler = opts.wrangler ?? false;
    // Default the wrangler `--env` to the `CLOUDFLARE_ENV` variable.
    this.#wranglerEnv = opts.wranglerEnv ?? process.env.CLOUDFLARE_ENV;
    this.#wranglerModule = opts.wranglerModule;
    this.#wranglerConfigPath = opts.wranglerConfigPath;
    this.#wranglerEnvFiles = opts.wranglerEnvFiles;
    this.#compatibilityDate = opts.compatibilityDate;
    this._initWithVirtualData(() => this.#init());
  }

  /** Dispose all persistent Miniflare instances from the cache. */
  static async disposeAll() {
    const entries = [..._miniflareCache.values()];
    _miniflareCache.clear();
    for (const entry of entries) {
      await entry.mf.dispose().catch(() => {});
    }
  }

  /** Fully dispose the Miniflare instance (even if persistent). */
  async dispose() {
    if (this.#miniflare) {
      if (this.#ws) {
        this.#ws.send(JSON.stringify({ type: "shutdown" }));
        this.#ws.close();
        this.#ws = undefined;
      }
      if (this.#cacheKey && _miniflareCache.get(this.#cacheKey)?.mf === this.#miniflare) {
        _miniflareCache.delete(this.#cacheKey);
      }
      await this.#miniflare.dispose();
      this.#miniflare = undefined;
    }
    if (!this.closed) {
      await this.close();
    }
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // Match BaseEnvRunner.fetch: wait with exponential backoff while init is
    // still in flight (the address is set at the end of #initAsync).
    for (let i = 0; i < 5 && !this._address && !this.closed; i++) {
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i)));
    }
    if (!this.#miniflare || this.closed) {
      return new Response("miniflare env runner is unavailable", { status: 503 });
    }
    const resolved = this._resolveFetchInput(input);
    // Treat request adapters as RequestInit dictionaries so all public request
    // properties survive without requiring native Request's private state.
    const request =
      typeof resolved === "string" || resolved instanceof URL
        ? new Request(resolved, init)
        : new Request(new Request(resolved.url, resolved), {
            ...init,
            referrer: init?.referrer ?? resolved.referrer,
            referrerPolicy: init?.referrerPolicy ?? resolved.referrerPolicy,
          });
    const res = await this.#miniflare.dispatchFetch(request.url, request);
    // workerd returns a Response from a different realm — convert to a standard Response
    // so that `instanceof Response` checks work in the caller's context.
    if (res instanceof Response) {
      return res;
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  sendMessage(message: unknown) {
    if (!this.#ws) {
      throw new Error("Miniflare env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally
    if ((message as any)?.type === "ping") {
      queueMicrotask(() => this._handleMessage({ type: "pong", data: (message as any).data }));
      return;
    }
    this.#ws.send(JSON.stringify({ type: "message", data: message }));
  }

  /**
   * Hot-reload the user entry module without recreating the Miniflare instance.
   *
   * Sends `reload-module` event over the WebSocket. The worker wrapper uses
   * `unsafeEvalBinding` to re-import the entry with a cache-busting query string
   * and responds with `module-reloaded` when done.
   */
  override async reloadModule(timeout = 5000): Promise<void> {
    if (!this.#ws) {
      throw new Error("Miniflare env runner should be initialized before reloading.");
    }
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      return;
    }
    this.#reloadCounter++;
    await this._request(
      { type: "reload", version: this.#reloadCounter },
      {
        match: (msg) => msg?.event === "module-reloaded",
        timeout,
        timeoutError: "Module reload timed out",
        send: (message) => this.#ws!.send(JSON.stringify(message)),
      },
    );
  }

  /**
   * Invalidate a virtual module so the next `reloadModule()` re-evaluates it.
   *
   * Host-side only (no worker round-trip): the module fallback service serves
   * virtual sources from a live map, so re-running a factory source and
   * bumping the per-specifier versions — the module plus its transitive
   * virtual importers — is enough. Import specifiers in re-served module code
   * are rewritten to the versioned form, giving workerd fresh module
   * identities (it caches by name). A `persistent` instance is evicted from
   * the cache, since its served sources no longer match the cache key.
   */
  override async invalidateModule(specifier: string, _timeout?: number): Promise<void> {
    const virtual = this.#virtual;
    if (!virtual || !Object.hasOwn(virtual, specifier)) {
      const hasVirtual = Object.keys((this._data?.virtual as object) ?? {}).length > 0;
      throw !virtual && hasVirtual && !this.closed
        ? new Error("Miniflare env runner should be initialized before invalidating modules.")
        : new Error(`Cannot invalidate "${specifier}" (not a registered virtual module)`);
    }
    const source = await this._refreshVirtualSource(specifier);
    if (source !== undefined) {
      virtual[specifier] = await this.#prepareVirtualSource(specifier, source);
    }
    for (const key of expandVirtualInvalidation(virtual, specifier)) {
      this.#virtualVersions.set(key, (this.#virtualVersions.get(key) ?? 0) + 1);
    }
    // The mutated sources no longer match the cache key — evict so future
    // runners constructed with the original sources get a fresh instance.
    // Current handles keep ref-counting through #cacheEntry.
    if (this.#cacheKey && _miniflareCache.get(this.#cacheKey) === this.#cacheEntry) {
      _miniflareCache.delete(this.#cacheKey);
    }
  }

  // #region Protected methods

  protected _hasRuntime() {
    return Boolean(this.#miniflare);
  }

  protected _runtimeType() {
    return "miniflare";
  }

  protected async _closeRuntime() {
    if (!this.#miniflare) {
      return;
    }
    if (this.#ws) {
      this.#ws.send(JSON.stringify({ type: "shutdown" }));
      this.#ws.close();
      this.#ws = undefined;
    }
    // Ref-count through the entry object (not a cache lookup): invalidation
    // evicts the entry from the cache while handles still share the instance.
    const entry = this.#cacheEntry;
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        if (this.#cacheKey && _miniflareCache.get(this.#cacheKey) === entry) {
          _miniflareCache.delete(this.#cacheKey);
        }
        await this.#miniflare.dispose();
      }
    } else {
      await this.#miniflare.dispose();
    }
    this.#miniflare = undefined;
  }

  // #endregion

  // #region Private methods

  /**
   * The `miniflare` package to run with: the explicitly passed module when
   * given, otherwise `import("miniflare")`. Throws only when neither is
   * available (or the passed module isn't miniflare).
   */
  async #resolveMiniflare(): Promise<MiniflareModule> {
    this.#miniflareModule = (await resolveRuntimeDep<MiniflareModule>({
      name: "miniflare",
      option: "miniflare",
      value: this.#miniflareModule,
      expect: "Miniflare",
      required: true,
      hint: 'MiniflareEnvRunner cannot run without it (`import * as miniflare from "miniflare"`).',
    }))!;
    return this.#miniflareModule as MiniflareModule;
  }

  #init() {
    this.#initAsync().catch((error) => {
      console.error("Miniflare runner init error:", error);
      this.close(error);
    });
  }

  override async upgrade(context: {
    node: { req: IncomingMessage; socket: Socket; head: any };
  }): Promise<void> {
    if (!this.#miniflare || this.closed) {
      context.node.socket.destroy();
      return;
    }
    // Proxy the WebSocket upgrade to Miniflare's internal workerd HTTP server
    const mfUrl = await this.#miniflare.unsafeGetDirectURL();
    const address = new URL(mfUrl);
    try {
      await proxyUpgrade(
        { host: address.hostname, port: Number(address.port) },
        context.node.req,
        context.node.socket,
        context.node.head,
      );
    } catch {
      // The worker may refuse the upgrade (e.g. the `upgrade` hook returned a
      // non-101 response to reject the connection). `proxyUpgrade` has already
      // settled the client socket (forwarding the upstream response or
      // destroying it), so swallow the rejection to avoid an unhandled promise
      // rejection in fire-and-forget callers.
    }
  }

  /**
   * Resolved `data.virtual` map, prepared for workerd. Sources arrive as plain
   * strings (factories are resolved on the host by `_initWithVirtualData()`).
   * workerd parses every `esModule` as plain JS, so `.ts`/`.mts` sources are
   * type-stripped here with `module.stripTypeScriptTypes`; `.json` sources stay
   * raw and are served as native `json` modules by the fallback service.
   */
  async #prepareVirtualModules(): Promise<Record<string, string> | undefined> {
    const virtual = this._data?.virtual as Record<string, string> | undefined;
    if (!virtual || Object.keys(virtual).length === 0) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [specifier, source] of Object.entries(virtual)) {
      out[specifier] = await this.#prepareVirtualSource(specifier, source);
    }
    return out;
  }

  async #prepareVirtualSource(specifier: string, source: string): Promise<string> {
    if (virtualModuleFormat(specifier) !== "module-typescript") {
      return source;
    }
    return stripVirtualTypeScript(specifier, source, await _getStripTypeScriptTypes(), {
      requirement: "on the host (workerd does not parse TypeScript)",
      remedy: "upgrade Node.js",
    });
  }

  async #initAsync() {
    const { Miniflare, supportedCompatibilityDate } = await this.#resolveMiniflare();

    const entryPath = this._data?.entry as string | undefined;
    const virtual = await this.#prepareVirtualModules();
    this.#virtual = virtual;

    // Optional wrangler config → Miniflare options (compat date/flags +
    // bindings). User-provided `miniflareOptions` win; flags are merged.
    const { options: wranglerOptions, configFile: wranglerConfigFile } = await loadWranglerConfig({
      wrangler: this.#wrangler,
      env: this.#wranglerEnv,
      entryPath,
      configPath: this.#wranglerConfigPath,
      wranglerModule: this.#wranglerModule,
      envFiles: this.#wranglerEnvFiles,
    });

    const userFlags = (this.#miniflareOptions.compatibilityFlags as string[]) || [];
    const wranglerFlags = (wranglerOptions?.compatibilityFlags as string[]) || [];
    const userDirectSockets = (this.#miniflareOptions.unsafeDirectSockets as unknown[]) || [];
    const options: Record<string, unknown> = {
      modules: true,
      // Share local state with `wrangler dev` (it persists under
      // `.wrangler/state/v3`) whenever wrangler config loading is enabled,
      // unless the user configured persistence themselves.
      ...(this.#wrangler && !hasUserPersistOptions(this.#miniflareOptions)
        ? {
            defaultPersistRoot: wranglerPersistRoot(
              wranglerConfigFile,
              typeof this.#wrangler === "string" ? this.#wrangler : this.#wranglerConfigPath,
            ),
          }
        : undefined),
      ...wranglerOptions,
      ...this.#miniflareOptions,
      // Default to the date supported by the installed workerd binary, not
      // today: the binary always lags the calendar by a few days, and a
      // future date makes workerd refuse to start ("requires compatibility
      // date X, but the newest date supported ... is Y"). `miniflare` exports
      // this already clamped to `min(today, binary date)`; newer dates from
      // any source are clamped to it too.
      compatibilityDate: resolveCompatibilityDate(
        [
          this.#miniflareOptions.compatibilityDate as string | undefined,
          this.#compatibilityDate === "latest"
            ? supportedCompatibilityDate
            : this.#compatibilityDate,
          wranglerOptions?.compatibilityDate as string | undefined,
        ],
        supportedCompatibilityDate,
      ),
      compatibilityFlags: resolveCompatibilityFlags(wranglerFlags, userFlags),
      // Expose a direct socket so we can proxy WebSocket upgrades via workerd
      unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }, ...userDirectSockets],
    };

    // Deep-merge nested record options (e.g. `bindings`) so user-supplied
    // `miniflareOptions` extend wrangler-derived ones per key instead of
    // replacing the whole object (user keys still win on conflict).
    if (wranglerOptions) {
      for (const [key, wValue] of Object.entries(wranglerOptions)) {
        const uValue = this.#miniflareOptions[key];
        if (isPlainObject(wValue) && isPlainObject(uValue)) {
          options[key] = { ...wValue, ...uValue };
        }
      }
    }

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      // A virtual entry is matched verbatim by the module fallback service —
      // don't resolve non-path specifiers (e.g. "#entry") against cwd.
      const entryIsVirtual = isVirtualSpecifier(entryPath, virtual);
      const resolvedEntry = entryIsVirtual ? entryPath : resolve(entryPath);
      // Anchor for scriptPath and bare-specifier resolution; a non-path
      // virtual key has no directory, so fall back to cwd.
      const entryBase = isAbsolute(resolvedEntry)
        ? resolvedEntry
        : resolve("__env_runner_virtual_entry__.mjs");
      const entryDir = dirname(entryBase);

      // Auto-detect exported classes from entry source (opt-in)
      const entrySource = entryIsVirtual ? virtual![entryPath] : _tryReadFile(resolvedEntry);
      const detectedExports =
        this.#exports === false || this.#exports === undefined
          ? []
          : detectExportedClasses(
              entrySource,
              typeof this.#exports === "object" ? this.#exports : {},
            );

      // The wrapper wires DO/Entrypoint exports as static re-exports from the
      // entry, which miniflare's ModuleLocator resolves on disk at startup —
      // impossible for a fallback-served virtual entry.
      if (entryIsVirtual && detectedExports.length > 0) {
        throw new Error(
          `[env-runner] named exports (${detectedExports.join(", ")}) are not supported with a virtual entry on the miniflare runner; pass \`exports: false\` or use a real entry file.`,
        );
      }

      // Auto-wire durableObjects bindings for detected/declared exports,
      // merged with wrangler-derived and user bindings: exports whose class
      // is already bound (or whose binding name is taken) are skipped.
      if (detectedExports.length > 0) {
        const existingDOs = isPlainObject(options.durableObjects) ? options.durableObjects : {};
        const boundClasses = new Set(
          Object.values(existingDOs).map((b) =>
            typeof b === "string" ? b : isPlainObject(b) && !b.scriptName ? b.className : undefined,
          ),
        );
        const autoDOs: Record<string, unknown> = { ...existingDOs };
        for (const name of detectedExports) {
          const bindingName = toScreamingSnakeCase(name);
          if (!autoDOs[bindingName] && !boundClasses.has(name)) {
            autoDOs[bindingName] = name;
          }
        }
        options.durableObjects = autoDOs;
      }

      options.script = generateWrapper(resolvedEntry, {
        dynamicOnly: true,
        captureErrors: this.#captureErrors,
        exports: detectedExports,
        nodeCompat: !(options.compatibilityFlags as string[]).includes("no_nodejs_compat"),
      });
      options.scriptPath = entryDir + "/__env_runner_wrapper.mjs";
      // Use "/" as modulesRoot so absolute paths don't produce ".." relative paths
      if (!options.modulesRoot) {
        options.modulesRoot = "/";
      }

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = UNSAFE_EVAL_BINDING;

      // Service binding for cross-request IPC (worker → runner).
      // In workerd, the WebSocket created during IPC handshake cannot be used
      // from a different request context. This binding provides an alternative
      // channel for sending messages back to the runner during fetch handling.
      const userBindings = (options.serviceBindings as Record<string, unknown>) || {};
      options.serviceBindings = {
        ...userBindings,
        [IPC_BINDING]: async (request: Request) => {
          try {
            const message = await request.json();
            this._handleMessage(message);
          } catch {
            // Ignore malformed messages
          }
          return new Response(null, { status: 204 });
        },
      };

      // When transformRequest is provided, add module rules so miniflare's
      // ModuleLocator doesn't reject non-JS extensions (e.g. .ts, .tsx, .jsx)
      if (this.#transformRequest && !options.modulesRules) {
        options.modulesRules = [
          { type: "ESModule", include: ["**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mts"] },
        ];
      }

      // Module fallback: resolve imports that workerd can't find on its own
      // (e.g. imports from node_modules, parent dirs, cache-busted reload imports)
      if (!options.unsafeModuleFallbackService) {
        const _require = createRequire(entryBase);
        const _virtual = virtual;
        const _virtualVersions = this.#virtualVersions;
        const _transformRequest = this.#transformRequest;
        const _exportConditions = this.#exportConditions;
        const _applyVirtualVersions = (code: string) =>
          applyVirtualVersions(code, _virtualVersions);
        options.unsafeUseModuleFallbackService = true;
        // Map workerd module names to real filesystem paths for correct
        // relative import resolution from bare-specifier modules.
        const modulePathMap = new Map<string, string>();
        const _lexersReady = Promise.all([ensureCjsLexer(), initEsmLexer]);
        options.unsafeModuleFallbackService = async (request: Request) => {
          await _lexersReady;
          const url = new URL(request.url);
          const specifier = url.searchParams.get("specifier");
          const rawSpecifier = url.searchParams.get("rawSpecifier");
          const referrer = url.searchParams.get("referrer") || "";
          if (!specifier) {
            return new Response(null, { status: 404 });
          }
          const cleanSpecifier = specifier.split("?")[0] || specifier;
          const cleanRaw = rawSpecifier?.split("?")[0];

          // Virtual modules (data.virtual) win over any other resolution — a
          // virtual key overrides a real file with the same path. The query is
          // kept in the returned name so reload cache-busting (`?t=<n>`) gives
          // workerd a fresh module identity while matching the same key.
          if (_virtual) {
            const bareSpecifier = cleanSpecifier.startsWith("/")
              ? cleanSpecifier.slice(1)
              : cleanSpecifier;
            const virtualKey = [cleanRaw, cleanSpecifier, bareSpecifier].find(
              (key) => key !== undefined && Object.hasOwn(_virtual, key),
            );
            if (virtualKey !== undefined) {
              const query = specifier.includes("?") ? specifier.slice(specifier.indexOf("?")) : "";
              const name = bareSpecifier + query;
              const source = _virtual[virtualKey]!;
              // workerd parses `json` modules natively (the parsed value is the
              // default export); `.ts`/`.mts` sources were already type-stripped
              // on the host (see #prepareVirtualModules).
              return virtualModuleFormat(virtualKey) === "json"
                ? Response.json({ name, json: source })
                : Response.json({ name, esModule: _applyVirtualVersions(source) });
            }
          }

          let resolvedPath: string;

          // file:// URL specifier — convert to filesystem path
          const fileUrlRaw = cleanRaw || cleanSpecifier;
          if (fileUrlRaw.startsWith("file://")) {
            try {
              resolvedPath = fileURLToPath(fileUrlRaw);
            } catch {
              return new Response(null, { status: 404 });
            }
          }
          // Bare specifier (npm package) — resolve via Node module resolution
          else if (cleanRaw && !cleanRaw.startsWith(".") && !cleanRaw.startsWith("/")) {
            // Resolve relative to the referrer's real path when available
            const referrerKey = referrer.startsWith("/") ? referrer.slice(1) : referrer;
            const referrerReal = modulePathMap.get(referrerKey);
            const contextRequire = referrerReal ? createRequire(referrerReal) : _require;
            // cloudflare:* modules are workerd built-ins
            if (cleanRaw.startsWith("cloudflare:")) {
              return new Response(null, { status: 404 });
            }
            // For node:* builtins not natively supported by workerd, use unenv polyfill
            if (cleanRaw.startsWith("node:")) {
              const nodeName = cleanRaw.slice(5);
              try {
                resolvedPath = contextRequire.resolve(`unenv/node/${nodeName}`);
              } catch {
                return new Response(null, { status: 404 });
              }
            } else {
              try {
                // Use exsolve with export conditions so packages with conditional
                // exports (e.g. srvx with "workerd" condition) resolve correctly.
                const resolved = resolveModulePath(cleanRaw, {
                  from: referrerReal || entryBase,
                  conditions: _exportConditions,
                  try: true,
                });
                resolvedPath = resolved || contextRequire.resolve(cleanRaw);
              } catch {
                // Return an empty stub for unresolvable bare specifiers (e.g. optional native addons like bufferutil)
                const name = cleanSpecifier.startsWith("/")
                  ? cleanSpecifier.slice(1)
                  : cleanSpecifier;
                return Response.json({ name, esModule: "export default undefined;" });
              }
            }
          } else {
            // Resolve against the referrer's real filesystem path
            const referrerKey = referrer.startsWith("/") ? referrer.slice(1) : referrer;
            const referrerReal =
              modulePathMap.get(referrerKey) ||
              (referrer.startsWith("/") ? referrer : "/" + referrer);
            const referrerDir = dirname(referrerReal);
            const raw = cleanRaw || cleanSpecifier;
            if (raw.startsWith(".")) {
              resolvedPath = resolve(referrerDir, raw);
            } else if (cleanSpecifier.startsWith("/")) {
              // Absolute specifier — use directly
              resolvedPath = cleanSpecifier;
            } else {
              try {
                resolvedPath = _require.resolve(raw);
              } catch {
                return new Response(null, { status: 404 });
              }
            }
          }

          // workerd requires name to match specifier
          // Preserve query string in name for cache-busting (workerd caches by name)
          const rawQuery = specifier.includes("?") ? specifier.slice(specifier.indexOf("?")) : "";
          const name =
            (cleanSpecifier.startsWith("/") ? cleanSpecifier.slice(1) : cleanSpecifier) + rawQuery;

          // Try Vite transform pipeline first (TS/JSX → JS, etc.)
          if (_transformRequest) {
            try {
              const result = await _transformRequest(resolvedPath);
              if (result?.code) {
                modulePathMap.set(name, resolvedPath);
                return Response.json({ name, esModule: _applyVirtualVersions(result.code) });
              }
            } catch {
              // Fall through to raw disk read
            }
          }

          try {
            const contents = readFileSync(resolvedPath, "utf8");
            // Track the real path so relative imports from this module resolve correctly
            modulePathMap.set(name, resolvedPath);
            // Detect module type: .mjs is always ESM, .cjs is always CJS,
            // otherwise check for ESM syntax indicators
            const isESM =
              resolvedPath.endsWith(".mjs") ||
              (!resolvedPath.endsWith(".cjs") &&
                /\b(import\s|import\(|export\s|export\{|import\.meta\b)/.test(contents));
            if (isESM) {
              return Response.json({ name, esModule: _applyVirtualVersions(contents) });
            }
            // Serve CJS modules with an ESM shim wrapper.
            // workerd's `commonJsModule` handles CJS execution (module/exports/require),
            // but callers expect ESM. We serve the raw CJS under a suffixed name and
            // return an ESM shim that re-imports and re-exports from it.
            const cjsSuffix = "?__cjs";
            if (specifier.endsWith(cjsSuffix)) {
              return Response.json({ name, commonJsModule: contents });
            }
            const shimSpecifier = "./" + basename(resolvedPath) + cjsSuffix;
            const esModule = createCjsEsmShim(shimSpecifier, contents);
            return Response.json({ name, esModule });
          } catch {
            return new Response(null, { status: 404 });
          }
        };
      }
    }

    // Persistent Miniflare: reuse cached instance if available
    if (this.#persistent && entryPath) {
      this.#cacheKey = computeCacheKey(entryPath, {
        ...this.#miniflareOptions,
        _exportConditions: this.#exportConditions,
        // The fallback service closure captures the virtual map, so instances
        // are only shareable when the resolved sources are identical.
        _virtual: virtual,
      });
      const cached = _miniflareCache.get(this.#cacheKey);
      if (cached) {
        this.#miniflare = cached.mf;
        cached.refCount++;
        this.#cacheEntry = cached;
        // The live fallback service closes over the creating runner's maps —
        // adopt them so invalidateModule() mutates what the instance actually
        // serves (the sources are identical by cache-key construction).
        this.#virtual = cached.virtual;
        this.#virtualVersions = cached.versions;
      }
    }

    if (!this.#miniflare) {
      this.#miniflare = new Miniflare(options);
      await this.#miniflare.ready;
      if (this.#persistent && this.#cacheKey) {
        this.#cacheEntry = {
          mf: this.#miniflare,
          refCount: 1,
          virtual,
          versions: this.#virtualVersions,
        };
        _miniflareCache.set(this.#cacheKey, this.#cacheEntry);
      }
    }

    // Establish persistent WebSocket connection for IPC
    const initRes = await this.#miniflare.dispatchFetch("http://localhost" + IPC_PATH, {
      headers: { upgrade: "websocket" },
    });
    const ws = initRes.webSocket;
    if (!ws) {
      const body = await initRes.text().catch(() => "");
      throw new Error(`Failed to establish WebSocket IPC channel (${initRes.status}: ${body})`);
    }
    ws.accept();
    this.#ws = ws;

    // Listen for messages from the worker
    ws.addEventListener("message", (event: { data: string }) => {
      try {
        const parsed = JSON.parse(event.data);
        this._handleMessage(parsed);
      } catch {
        // Ignore malformed messages
      }
    });

    // Signal ready with a dummy address (fetch is overridden)
    this._handleMessage({ address: { host: "127.0.0.1", port: 0 } });
  }

  // #endregion
}

// #region Helpers

/**
 * Detect `export class` declarations in the entry source.
 * Merges with explicitly declared exports from options.
 */
function detectExportedClasses(
  entrySource: string | undefined,
  explicit: Record<string, MiniflareExportInfo>,
): string[] {
  const names = new Set(Object.keys(explicit));
  if (entrySource) {
    const re = /\bexport\s+class\s+(\w+)/g;
    let match;
    while ((match = re.exec(entrySource))) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Pick the first defined compatibility date from `candidates` (highest
 * precedence first), defaulting to `supported`. A date newer than `supported`
 * (the installed workerd's newest date) falls back to it with a warning —
 * workerd refuses to start otherwise. Dates compare as `YYYY-MM-DD` strings.
 */
function resolveCompatibilityDate(
  candidates: (string | undefined)[],
  supported: string | undefined,
): string | undefined {
  const date = candidates.find((d) => typeof d === "string" && d) ?? supported;
  if (date && supported && _isDateString(date) && _isDateString(supported) && date > supported) {
    console.warn(
      `[env-runner] compatibility date "${date}" is newer than the installed workerd supports; falling back to "${supported}".`,
    );
    return supported;
  }
  return date;
}

/**
 * Union wrangler-derived and user compatibility flags, defaulting
 * `nodejs_compat` on unless either opts out with `no_nodejs_compat` (workerd
 * refuses to start with both: "mutually contradictory"). User flags win the
 * pair: a user `no_nodejs_compat` drops a wrangler `nodejs_compat` and vice versa.
 */
function resolveCompatibilityFlags(wranglerFlags: string[], userFlags: string[]): string[] {
  const opposite = (flag: string) =>
    flag === "nodejs_compat"
      ? "no_nodejs_compat"
      : flag === "no_nodejs_compat"
        ? "nodejs_compat"
        : undefined;
  const flags = [
    ...wranglerFlags.filter((flag) => !userFlags.includes(opposite(flag)!)),
    ...userFlags,
  ];
  const defaults = flags.includes("no_nodejs_compat") ? [] : ["nodejs_compat"];
  return [...new Set([...defaults, ...flags])];
}

function _isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Whether user `miniflareOptions` configure persistence (`defaultPersistRoot` or any `*Persist`). */
function hasUserPersistOptions(options: Record<string, unknown>): boolean {
  return Object.keys(options).some(
    (key) => key === "defaultPersistRoot" || key.endsWith("Persist"),
  );
}

/**
 * Default `defaultPersistRoot` for wrangler configs (`<dir>/.wrangler/state/v3`,
 * where `wrangler dev` persists). Anchored to the loaded config file's dir,
 * else the explicitly requested config path's dir (even if missing), else cwd
 * (where `wrangler dev` runs).
 */
function wranglerPersistRoot(configFile?: string, explicitPath?: string): string {
  const file = configFile ?? (explicitPath ? resolve(explicitPath) : undefined);
  return join(file ? dirname(file) : process.cwd(), ".wrangler/state/v3");
}

/** Entry might not exist yet (e.g. generated at build time). */
function _tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Convert PascalCase/camelCase to SCREAMING_SNAKE_CASE (e.g. `Counter` → `COUNTER`, `MyDurableObject` → `MY_DURABLE_OBJECT`). */
function toScreamingSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Compute a stable cache key for persistent Miniflare instances. */
function computeCacheKey(entryPath: string, opts: Record<string, unknown>): string {
  const serializableOpts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v !== "function") {
      serializableOpts[k] = v;
    }
  }
  return `${resolve(entryPath)}::${JSON.stringify(serializableOpts)}`;
}

/**
 * Rewrite import specifiers of invalidated virtual modules in re-served module
 * code to their current version (`#config.json` → `#config.json?v=2`). workerd
 * caches modules by name, so the versioned specifier misses its registry, hits
 * the fallback again, and the fresh source is served under a new identity.
 * Only parsed import/re-export specifiers are rewritten (es-module-lexer) —
 * never arbitrary string literals in the code.
 */
function applyVirtualVersions(code: string, versions: ReadonlyMap<string, number>): string {
  if (versions.size === 0) {
    return code;
  }
  let imports: ReturnType<typeof parseEsm>[0];
  try {
    [imports] = parseEsm(code);
  } catch {
    // Unparsable code is served untouched — workerd reports its own error.
    return code;
  }
  let out = "";
  let last = 0;
  for (const imp of imports) {
    if (imp.type === "import-meta") {
      continue;
    }
    const dynamic = imp.type === "dynamic";
    // A template-literal dynamic import with substitutions is reported as a
    // glob specifier (each `${...}` collapsed to `*`), never a real key.
    if (dynamic && imp.glob) {
      continue;
    }
    const specifier = imp.specifier;
    const version = specifier === undefined ? undefined : versions.get(specifier);
    if (!version) {
      continue;
    }
    const versioned = `${specifier}?v=${version}`;
    // Static import/re-export offsets exclude the quotes; dynamic import
    // offsets span the full specifier expression including them.
    out += code.slice(last, imp.start) + (dynamic ? JSON.stringify(versioned) : versioned);
    last = imp.end;
  }
  return out + code.slice(last);
}

// `node:module` is imported lazily (only when a TS virtual source is present)
// and the lookup is cached across sources and invalidations.
let _stripTypesPromise: Promise<((code: string) => string) | undefined> | undefined;

function _getStripTypeScriptTypes() {
  _stripTypesPromise ??= import("node:module").then((m) => (m as any).stripTypeScriptTypes);
  return _stripTypesPromise;
}

let _cjsLexerReady: Promise<void> | undefined;

function ensureCjsLexer() {
  if (!_cjsLexerReady) {
    _cjsLexerReady = initCjsLexer();
  }
  return _cjsLexerReady;
}

function createCjsEsmShim(cjsSpecifier: string, contents: string): string {
  let namedExports: string[] = [];
  try {
    const { exports } = parseCjs(contents);
    namedExports = exports.filter((e) => e !== "default" && e !== "__esModule");
  } catch {
    // If parsing fails, just use default export
  }
  const quoted = JSON.stringify(cjsSpecifier);
  let shim = `import __cjs_mod__ from ${quoted};\nexport default __cjs_mod__;\n`;
  for (const name of namedExports) {
    shim += `export var ${name} = __cjs_mod__["${name}"];\n`;
  }
  return shim;
}

// #endregion
