import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModulePath } from "exsolve";
import { init as initCjsLexer, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { proxyUpgrade } from "httpxy";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import { isVirtualSpecifier } from "../../common/worker-utils.ts";
import {
  expandVirtualInvalidation,
  stripVirtualTypeScript,
  virtualModuleFormat,
} from "../../virtual-loader.ts";
import { generateWrapper, IPC_BINDING } from "./wrapper.ts";
import { isPlainObject, loadWranglerConfig } from "./wrangler.ts";
import type { WranglerInlineConfig } from "./wrangler.ts";

export type { WranglerInlineConfig } from "./wrangler.ts";
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

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
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
   * - `true` — auto-discover `wrangler.{json,jsonc,toml}` next to the entry
   *   file, then in the current working directory.
   * - `string` — explicit path to a wrangler config file.
   * - `object` — an inline raw (snake_case) wrangler config, as you would
   *   write in `wrangler.json` (no file needed). A config file is still
   *   auto-discovered (next to the entry, then cwd) and the inline config is
   *   merged on top of it (inline wins per key, binding records merge,
   *   `compatibilityFlags` are unioned).
   *
   * The installed `wrangler` package is preferred (full fidelity: TOML,
   * `env` inheritance, `.dev.vars`, every binding type; an inline config is
   * normalized through a short-lived temp file). When `wrangler` is not
   * installed, a built-in minimal reader handles plain JSON files and inline
   * objects (common fields only) and a one-time warning is logged. JSONC and
   * TOML files without `wrangler` are skipped with a warning. Values from
   * `miniflareOptions` always win over config-derived ones; binding records
   * (e.g. `bindings`) merge per key and `compatibilityFlags` are unioned.
   */
  wrangler?: boolean | string | WranglerInlineConfig;
  /**
   * Wrangler environment (`--env`) to select when loading the config.
   * Defaults to the `CLOUDFLARE_ENV` environment variable.
   */
  wranglerEnv?: string;
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

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareOptions = opts.miniflareOptions || {};
    this.#transformRequest = opts.transformRequest;
    this.#persistent = opts.persistent ?? false;
    this.#exports = opts.exports ?? {};
    this.#captureErrors = opts.captureErrors ?? true;
    this.#exportConditions = opts.exportConditions ?? ["workerd", "worker"];
    this.#wrangler = opts.wrangler ?? false;
    // Default the wrangler `--env` to the `CLOUDFLARE_ENV` variable.
    this.#wranglerEnv = opts.wranglerEnv ?? process.env.CLOUDFLARE_ENV;
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
    const url =
      typeof resolved === "string"
        ? resolved
        : resolved instanceof URL
          ? resolved.href
          : resolved.url;
    const res = await this.#miniflare.dispatchFetch(url, init);
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
    const { Miniflare, supportedCompatibilityDate } = await import("miniflare");

    const entryPath = this._data?.entry as string | undefined;
    const virtual = await this.#prepareVirtualModules();
    this.#virtual = virtual;

    // Optional wrangler config → Miniflare options (compat date/flags +
    // bindings). User-provided `miniflareOptions` win; flags are merged.
    const wranglerOptions = await loadWranglerConfig(this.#wrangler, this.#wranglerEnv, entryPath);

    const userFlags = (this.#miniflareOptions.compatibilityFlags as string[]) || [];
    const wranglerFlags = (wranglerOptions?.compatibilityFlags as string[]) || [];
    const userDirectSockets = (this.#miniflareOptions.unsafeDirectSockets as unknown[]) || [];
    const options: Record<string, unknown> = {
      // Default to the date supported by the installed workerd binary, not
      // today: the binary always lags the calendar by a few days, and pinning
      // a future date makes workerd refuse to start ("requires compatibility
      // date X, but the newest date supported ... is Y"). `miniflare` exports
      // this already clamped to `min(today, binary date)`.
      compatibilityDate: supportedCompatibilityDate,
      modules: true,
      ...wranglerOptions,
      ...this.#miniflareOptions,
      compatibilityFlags: [...new Set(["nodejs_compat", ...wranglerFlags, ...userFlags])],
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

      // Auto-wire durableObjects bindings for detected/declared exports
      if (detectedExports.length > 0 && !options.durableObjects) {
        const userDOs = (this.#miniflareOptions.durableObjects as Record<string, string>) || {};
        const autoDOs: Record<string, string> = { ...userDOs };
        for (const name of detectedExports) {
          const bindingName = toScreamingSnakeCase(name);
          if (!autoDOs[bindingName]) {
            autoDOs[bindingName] = name;
          }
        }
        options.durableObjects = autoDOs;
      }

      options.script = generateWrapper(resolvedEntry, {
        dynamicOnly: true,
        captureErrors: this.#captureErrors,
        exports: detectedExports,
      });
      options.scriptPath = entryDir + "/__env_runner_wrapper.mjs";
      // Use "/" as modulesRoot so absolute paths don't produce ".." relative paths
      if (!options.modulesRoot) {
        options.modulesRoot = "/";
      }

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = "__ENV_RUNNER_UNSAFE_EVAL__";

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
    let specifier: string | undefined = imp.n;
    // `n` is unset for template-literal dynamic imports; extract a plain
    // `import(`...`)` literal (no substitutions) manually.
    if (specifier === undefined && imp.d > -1) {
      const expr = code.slice(imp.s, imp.e);
      if (expr.length > 1 && expr[0] === "`" && expr.endsWith("`") && !expr.includes("${")) {
        specifier = expr.slice(1, -1);
      }
    }
    const version = specifier === undefined ? undefined : versions.get(specifier);
    if (!version) {
      continue;
    }
    const versioned = `${specifier}?v=${version}`;
    // Static import/re-export offsets exclude the quotes; dynamic import
    // offsets span the full specifier expression including them.
    out += code.slice(last, imp.s) + (imp.d > -1 ? JSON.stringify(versioned) : versioned);
    last = imp.e;
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
