import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveModulePath } from "exsolve";
import { init as initCjsLexer, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import { proxyUpgrade } from "httpxy";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";
import {
  encodeVirtualModules,
  expandVirtualInvalidation,
  stripVirtualTypeScript,
  unsupportedVirtualJSXError,
  virtualModuleCode,
  virtualModuleCodeSource,
  virtualModuleFormat,
} from "../../virtual-loader.ts";
import type { ResolvedVirtualModule, VirtualModule } from "../../virtual-loader.ts";
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

/** The `miniflare` package namespace (v4 or v5), as imported by the app. */
export interface MiniflareModule {
  Miniflare: new (options: any) => any;
  /** Newest date the installed `workerd` supports, clamped to today (v4 only). */
  supportedCompatibilityDate?: string;
  /** Converts v4 options, which the runner builds, to the v5 format (v5 only). */
  convertV4MiniflareOptions?: (options: any) => any;
  [key: string]: unknown;
}

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /**
   * The `miniflare` package (`import * as miniflare from "miniflare"`) or a
   * specifier resolved from cwd. Omitted: imported optionally.
   */
  miniflare?: RuntimeDep<MiniflareModule>;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
  /**
   * `"latest"` uses the installed workerd's newest date. Precedence:
   * `miniflareOptions` > this > wrangler config > newest supported. Dates newer
   * than workerd supports fall back with a warning (workerd refuses them).
   */
  compatibilityDate?: "latest" | (string & {});
  /**
   * Transform modules served by the fallback service (e.g. Vite's
   * `environment.transformRequest`). `id` is an absolute path; return nullish to
   * read from disk.
   */
  transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  /**
   * Named exports (Durable Objects, WorkerEntrypoints) to bind and re-export.
   * Default (or `true`): detect `export class` in the entry and auto-bind them;
   * a record merges with detected ones; `false` disables it.
   * A module specifier (absolute path or `data.virtual` key; relative paths
   * resolve from the entry's directory) is re-exported with `export *` instead:
   * nothing is detected or auto-bound (configure bindings with `wrangler` or
   * `miniflareOptions`) and the entry's own classes are not re-exported.
   * Exports load at startup, so changes need a new runner (not `reloadModule()`).
   */
  exports?: Record<string, MiniflareExportInfo> | boolean | string;
  /** Reuse the Miniflare instance across runner swaps; only `dispose()` destroys it. */
  persistent?: boolean;
  /** Wrap the user's `fetch` in a try/catch that returns structured JSON error responses. Default: `true`. */
  captureErrors?: boolean;
  /** Export conditions for the fallback service (default `["workerd", "worker"]`). */
  exportConditions?: string[];
  /**
   * Load a wrangler config into Miniflare options (compat date/flags, bindings).
   *
   * - `true` — auto-discover `wrangler.{json,jsonc,toml}` near the entry or cwd
   * - `string` — config file path
   * - `object` — inline raw config merged over the file config (inline wins per
   *   key, binding records merge, flags union); its top level is used when it
   *   lacks the selected env
   *
   * Options a single dev worker can't run (`assets`, services, queue consumers,
   * workflows, tails, other-script Durable Objects) are dropped with a warning.
   * `defaultPersistRoot` (v5: `resourcePersistencePath`) defaults to
   * `.wrangler/state/v3` next to the config (else cwd), shared with
   * `wrangler dev`. The `wrangler` package gives full fidelity (and may run its
   * npm update check); without it only plain JSON is read. `miniflareOptions`
   * always win.
   */
  wrangler?: boolean | string | WranglerInlineConfig;
  /**
   * Config file instead of auto-discovery when `wrangler` is `true` or inline
   * (resolved from cwd). Ignored when `wrangler` is a path.
   */
  wranglerConfigPath?: string;
  /** Wrangler `--env` to select (default: `CLOUDFLARE_ENV`). */
  wranglerEnv?: string;
  /**
   * `.env` files for dev vars (like `getPlatformProxy({ envFiles })`), resolved
   * from the config dir; later files win. Non-empty skips `.dev.vars`; `[]`
   * reads only `.dev.vars`. Requires the `wrangler` package.
   */
  wranglerEnvFiles?: string[];
  /**
   * The `wrangler` package for full-fidelity config parsing. Omitted: imported
   * optionally. `false`: always use the minimal JSON reader.
   */
  wranglerModule?: RuntimeDep<WranglerModule>;
}

const IPC_PATH = "/__env_runner_ipc";

/**
 * Virtual modules an instance's fallback service serves, read live (so
 * updates need no restart) and adopted by the runners attaching to it.
 */
interface MiniflareVirtualModules {
  /** Served modules (see {@link ServedVirtualModule}). */
  sources: Record<string, ServedVirtualModule>;
  /**
   * Removed keys: their importers keep versioning the import, so a re-served
   * importer misses workerd's cache and the fallback serves the real module.
   */
  removed: Set<string>;
  versions: Map<string, number>;
  /** Last version handed out (unique, so no two instances share a name). */
  version: number;
  /** Import specifier → served key. */
  keyOf: VirtualKeyResolver;
  /** Import specifier → served or removed key, for versioning imports. */
  versionedKeyOf: VirtualKeyResolver;
}

/** A module as the fallback serves it: TypeScript stripped, format explicit. */
type ServedVirtualModule = Required<VirtualModule> & {
  format: "module" | "commonjs" | "json" | "text" | "bytes" | "wasm";
};

interface MiniflareCacheEntry {
  mf: InstanceType<any>;
  refCount: number;
  virtual: MiniflareVirtualModules;
  // Receiver of the instance's `__ENV_RUNNER_IPC` binding; retargeted to the
  // runner that attaches last (like the IPC WebSocket).
  ipc: { runner: MiniflareEnvRunner };
}

// Module-level cache for persistent Miniflare instances
const _miniflareCache = new Map<string, MiniflareCacheEntry>();

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  #reloadCounter = 0;
  #virtual?: MiniflareVirtualModules;
  #cacheEntry?: MiniflareCacheEntry;
  #ws?: { send(data: string): void; close(): void };
  #persistent: boolean;
  #cacheKey?: string;
  #exports: Record<string, MiniflareExportInfo> | boolean | string;
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
    // `redirect: "manual"` returns worker 3xx responses as-is (like proxyFetch)
    // instead of letting dispatchFetch's undici fetch follow them.
    const request =
      typeof resolved === "string" || resolved instanceof URL
        ? new Request(resolved, { ...init, redirect: "manual" })
        : new Request(new Request(resolved.url, resolved), {
            ...init,
            redirect: "manual",
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

  /** Hot-reload the entry without recreating the Miniflare instance. */
  override async reloadModule(timeout = 5000): Promise<void> {
    await this._virtualUpdates;
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
   * Host-side only: the fallback service serves a live map, so changing it and
   * bumping versions (see {@link applyVirtualVersions}) is enough.
   */
  protected override async _applyVirtualUpdates(
    changes: Record<string, ResolvedVirtualModule | null>,
  ): Promise<void> {
    const virtual = this.#virtual;
    if (!virtual) {
      throw new Error("Miniflare env runner should be initialized before updating modules.");
    }
    // Prepared first: a source that fails to strip (or is JSX) changes nothing.
    const prepared: Record<string, ServedVirtualModule> = {};
    for (const [key, module] of Object.entries(changes)) {
      if (module !== null) {
        prepared[key] = await this.#prepareVirtualModule(key, module);
      }
    }
    // Importers over the sources before and after the change: a removed key
    // keeps its importers, and an added one finds those that already import it.
    // Import edges catch importers the quoted key scan misses (`./dep.mjs`).
    await initEsmLexer;
    const merged = { ...virtual.sources, ...prepared };
    const importers = virtualImporters(merged, createVirtualKeyResolver(Object.keys(merged)));
    const invalidated = expandVirtualInvalidation(merged, Object.keys(changes), importers);
    for (const key of Object.keys(changes)) {
      if (Object.hasOwn(prepared, key)) {
        virtual.sources[key] = prepared[key]!;
        virtual.removed.delete(key);
      } else if (Object.hasOwn(virtual.sources, key)) {
        delete virtual.sources[key];
        virtual.removed.add(key);
      }
    }
    for (const key of invalidated) {
      virtual.versions.set(key, ++virtual.version);
    }
    refreshVirtualKeyResolvers(virtual);
    // Sources no longer match the cache key; current handles stay ref-counted.
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
      // The worker may reject the upgrade; `proxyUpgrade` already settled the
      // client socket, so swallow (callers are fire-and-forget).
    }
  }

  async #prepareVirtualModules(): Promise<Record<string, ServedVirtualModule>> {
    const virtual = (this._data?.virtual ?? {}) as Record<string, ResolvedVirtualModule>;
    const out: Record<string, ServedVirtualModule> = {};
    for (const [key, module] of Object.entries(virtual)) {
      out[key] = await this.#prepareVirtualModule(key, module);
    }
    return out;
  }

  /**
   * workerd parses `esModule`/`commonJsModule` sources as JS, so TypeScript is
   * stripped here, and it has no JSX. Other formats are served natively (or,
   * for `bytes`, as an ES module).
   */
  async #prepareVirtualModule(
    key: string,
    module: ResolvedVirtualModule,
  ): Promise<ServedVirtualModule> {
    const format = virtualModuleFormat(key, module);
    const source = typeof module === "string" ? module : module.source;
    switch (format) {
      case "module-typescript":
      case "commonjs-typescript": {
        const stripped = stripVirtualTypeScript(
          key,
          source as string,
          await _getStripTypeScriptTypes(),
          {
            requirement: "on the host (workerd does not parse TypeScript)",
            remedy: "upgrade Node.js",
          },
        );
        return { source: stripped, format: format === "module-typescript" ? "module" : "commonjs" };
      }
      case "jsx":
      case "tsx": {
        throw unsupportedVirtualJSXError(key, format, "workerd");
      }
    }
    return { source, format };
  }

  async #initAsync() {
    const miniflare = await this.#resolveMiniflare();
    const supportedCompatibilityDate = await resolveSupportedCompatibilityDate(miniflare);

    const entryPath = this._data?.entry as string | undefined;
    const initialVirtual = await this.#prepareVirtualModules();
    // Always created, even empty: updates may add keys later.
    const virtual = createMiniflareVirtualModules({ ...initialVirtual });
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
      // Share local state with `wrangler dev` unless persistence is configured.
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
      // Not today: the workerd binary lags the calendar and refuses newer dates.
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

    // Deep-merge records (e.g. `bindings`) so user keys extend wrangler's.
    if (wranglerOptions) {
      for (const [key, wValue] of Object.entries(wranglerOptions)) {
        const uValue = this.#miniflareOptions[key];
        if (isPlainObject(wValue) && isPlainObject(uValue)) {
          options[key] = { ...wValue, ...uValue };
        }
      }
    }

    const ipc: MiniflareCacheEntry["ipc"] = { runner: this };

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      // A virtual entry is matched like the fallback service matches imports:
      // verbatim (don't resolve "#entry" against cwd), or by path for path keys.
      const entryKey = virtual.keyOf(entryPath) ?? virtual.keyOf(resolve(entryPath));
      const entryIsVirtual = entryKey !== undefined;
      // Path keys load by path (workerd has no `file:` scheme).
      const resolvedEntry = entryIsVirtual
        ? (virtualKeyPath(entryKey) ?? entryKey)
        : resolve(entryPath);
      // Anchor for scriptPath and bare-specifier resolution; a non-path
      // virtual key has no directory, so fall back to cwd.
      const entryBase = isAbsolute(resolvedEntry)
        ? resolvedEntry
        : resolve("__env_runner_virtual_entry__.mjs");
      const entryDir = dirname(entryBase);

      // Auto-detect exported classes from entry source (skipped for a module specifier)
      const entrySource = entryIsVirtual
        ? virtualModuleCodeSource(entryKey, virtual.sources[entryKey])
        : _tryReadFile(resolvedEntry);
      const detectedExports =
        this.#exports === false || typeof this.#exports === "string"
          ? []
          : detectExportedClasses(
              entrySource,
              typeof this.#exports === "object" ? this.#exports : {},
            );

      // Skip exports whose class is already bound or whose binding name is taken.
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

      const script = generateWrapper(
        entryIsVirtual ? toWorkerdPath(resolvedEntry) : resolvedEntry,
        {
          dynamicOnly: true,
          captureErrors: this.#captureErrors,
          exports: typeof this.#exports === "string" ? this.#exports : detectedExports,
          nodeCompat: !(options.compatibilityFlags as string[]).includes("no_nodejs_compat"),
        },
      );
      const scriptPath = entryDir + "/__env_runner_wrapper.mjs";
      // Static re-exports (an `exports` module, or a virtual entry's classes) must
      // reach the fallback service. v4's ModuleLocator would read them from disk
      // instead, but it only walks `script`; a module list skips it.
      const skipLocator =
        typeof this.#exports === "string" || (entryIsVirtual && detectedExports.length > 0);
      if (skipLocator) {
        options.modules = [{ type: "ESModule", path: scriptPath, contents: script }];
      } else {
        options.script = script;
        options.scriptPath = scriptPath;
      }
      // Use "/" as modulesRoot so absolute paths don't produce ".." relative paths
      if (!options.modulesRoot) {
        options.modulesRoot = "/";
      }

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = UNSAFE_EVAL_BINDING;

      // workerd forbids using the IPC WebSocket from another request context,
      // so worker messages go through this binding once a request was seen.
      const userBindings = (options.serviceBindings as Record<string, unknown>) || {};
      options.serviceBindings = {
        ...userBindings,
        [IPC_BINDING]: async (request: Request) => {
          try {
            const message = await request.json();
            ipc.runner._handleMessage(message);
          } catch {
            // Ignore malformed messages
          }
          return new Response(null, { status: 204 });
        },
      };

      // When transformRequest is provided, add module rules so miniflare's
      // ModuleLocator doesn't reject non-JS extensions (e.g. .ts, .tsx, .jsx).
      // v5 has no ModuleLocator (and rejects `modulesRules`): imports all go
      // through the fallback service.
      if (
        this.#transformRequest &&
        !options.modulesRules &&
        !miniflare.convertV4MiniflareOptions &&
        !skipLocator
      ) {
        options.modulesRules = [
          { type: "ESModule", include: ["**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mts"] },
        ];
      }

      // Module fallback: resolve imports that workerd can't find on its own
      // (e.g. imports from node_modules, parent dirs, cache-busted reload imports)
      if (!options.unsafeModuleFallbackService) {
        const _require = createRequire(entryBase);
        // Read live: updates change it in place.
        const _virtual = virtual;
        const _transformRequest = this.#transformRequest;
        const _exportConditions = this.#exportConditions;
        // `modulePath`: the served module's path, which its relative imports join onto.
        const _applyVirtualVersions = (code: string, modulePath: string | undefined) =>
          applyVirtualVersions(code, _virtual.versions, (specifier) =>
            _virtual.versionedKeyOf(specifier, modulePath),
          );
        // workerd module types, except `bytes`: a `data` module is an
        // ArrayBuffer, not a `Uint8Array`. Only ES modules have their imports
        // versioned (see `applyVirtualVersions`).
        const _serveVirtual = (module: ServedVirtualModule, modulePath: string | undefined) => {
          const { source } = module;
          switch (module.format) {
            case "module": {
              return { esModule: _applyVirtualVersions(source as string, modulePath) };
            }
            case "commonjs": {
              return {
                commonJsModule: source,
                namedExports: commonJSExports(source as string).filter((e) => e !== "default"),
              };
            }
            case "json": {
              return { json: source };
            }
            case "text": {
              return { text: source };
            }
            case "bytes": {
              return { esModule: virtualModuleCode("bytes", source) };
            }
            case "wasm": {
              return { wasm: Array.from(source as Uint8Array) };
            }
          }
        };
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

          // Virtual modules override real files. Keep the `?t=` query in the name
          // so reloads get a fresh workerd module identity.
          const bareSpecifier = cleanSpecifier.startsWith("/")
            ? cleanSpecifier.slice(1)
            : cleanSpecifier;
          // Real path of the referrer (disk file or path key), if served here.
          const referrerKey = referrer.startsWith("/") ? referrer.slice(1) : referrer;
          const referrerPath = modulePathMap.get(referrerKey);
          // Match the raw specifier against the referrer's real path first:
          // workerd joins a `file:` specifier onto the referrer's directory like
          // a relative path, and on Windows module names are native paths
          // (`D:\app\x.mjs`) it can't join relative specifiers onto at all.
          const virtualKey =
            [cleanRaw, cleanSpecifier, bareSpecifier].find(
              (key) => key !== undefined && Object.hasOwn(_virtual.sources, key),
            ) ??
            (cleanRaw ? _virtual.keyOf(cleanRaw, referrerPath) : undefined) ??
            _virtual.keyOf(cleanSpecifier);
          if (virtualKey !== undefined) {
            const query = specifier.includes("?") ? specifier.slice(specifier.indexOf("?")) : "";
            const keyPath = virtualKeyPath(virtualKey);
            // Redirect a `file:` import to the key's path: one module identity
            // for both spellings, and its relative imports resolve. workerd
            // requests the location verbatim (no `file:` left, so no loop) and
            // reads header bytes as UTF-8.
            if (
              keyPath &&
              cleanRaw?.startsWith("file:") &&
              cleanSpecifier !== keyPath &&
              cleanSpecifier.includes("file:")
            ) {
              const location = Buffer.from(toWorkerdPath(keyPath) + query, "utf8").toString(
                "latin1",
              );
              return new Response(null, { status: 301, headers: { location } });
            }
            const name = bareSpecifier + query;
            if (keyPath) {
              // Its relative imports resolve against the key's path.
              modulePathMap.set(name, keyPath);
            }
            return Response.json({
              name,
              ..._serveVirtual(_virtual.sources[virtualKey]!, keyPath),
            });
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
          // Bare specifier (npm package) — resolve via Node module resolution.
          // Not a Windows absolute path (`D:\app\x.mjs`), which isn't `/`-rooted.
          else if (
            cleanRaw &&
            !cleanRaw.startsWith(".") &&
            !cleanRaw.startsWith("/") &&
            !isAbsolute(cleanRaw)
          ) {
            // Resolve relative to the referrer's real path when available
            const referrerReal = referrerPath;
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
            const referrerReal =
              referrerPath || (referrer.startsWith("/") ? referrer : "/" + referrer);
            const referrerDir = dirname(referrerReal);
            const raw = cleanRaw || cleanSpecifier;
            if (raw.startsWith(".")) {
              resolvedPath = resolve(referrerDir, raw);
            } else if (cleanRaw && isAbsolute(cleanRaw) && !cleanRaw.startsWith("/")) {
              // Windows absolute path, e.g. the wrapper's entry import
              resolvedPath = cleanRaw;
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
                return Response.json({
                  name,
                  esModule: _applyVirtualVersions(result.code, resolvedPath),
                });
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
              return Response.json({
                name,
                esModule: _applyVirtualVersions(contents, resolvedPath),
              });
            }
            // Importers expect ESM: serve raw CJS under a suffixed name behind an ESM shim.
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
        _exports: this.#exports,
        // The fallback service closure captures the virtual map, so instances
        // are only shareable when the resolved sources are identical (bytes
        // compared as base64, not as JSON objects of indices).
        _virtual: encodeVirtualModules(initialVirtual),
      });
      const cached = _miniflareCache.get(this.#cacheKey);
      if (cached) {
        this.#miniflare = cached.mf;
        cached.refCount++;
        this.#cacheEntry = cached;
        cached.ipc.runner = this;
        // Adopt the state the live fallback service closes over.
        this.#virtual = cached.virtual;
      }
    }

    if (!this.#miniflare) {
      this.#miniflare = new miniflare.Miniflare(toMiniflareOptions(miniflare, options));
      await this.#miniflare.ready;
      if (this.#persistent && this.#cacheKey) {
        this.#cacheEntry = {
          mf: this.#miniflare,
          refCount: 1,
          virtual,
          ipc,
        };
        _miniflareCache.set(this.#cacheKey, this.#cacheEntry);
      }
    }

    // Load the entry with a plain request first, so a load error arrives as a
    // normal response: miniflare leaves the socket of a failed WebSocket upgrade
    // without an error listener, and disposing workerd then resets it (an
    // uncaught ECONNRESET on Windows).
    const loadRes = await this.#miniflare.dispatchFetch("http://localhost" + IPC_PATH);
    const loadBody = await loadRes.text().catch(() => "");
    if (!loadRes.ok) {
      throw new Error(`Failed to establish WebSocket IPC channel (${loadRes.status}: ${loadBody})`);
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

/** Detect `export class` names in the entry, merged with declared exports. */
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
 * Options are built in the v4 format (as wrangler's
 * `unstable_getMiniflareWorkerOptions` returns them); v5 converts them.
 */
function toMiniflareOptions(
  miniflare: MiniflareModule,
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (!miniflare.convertV4MiniflareOptions) {
    return options;
  }
  // v5 replaced `defaultPersistRoot` with `resourcePersistencePath`; the
  // converter drops it.
  const { defaultPersistRoot, ...rest } = options;
  return miniflare.convertV4MiniflareOptions({
    resourcePersistencePath: defaultPersistRoot,
    ...rest,
  });
}

/**
 * Newest date the installed `workerd` supports, clamped to today. miniflare v4
 * exports it; for v5, read `workerd` (a miniflare dependency) the same way.
 */
async function resolveSupportedCompatibilityDate(
  miniflare: MiniflareModule,
): Promise<string | undefined> {
  if (typeof miniflare.supportedCompatibilityDate === "string") {
    return miniflare.supportedCompatibilityDate;
  }
  try {
    const from = [process.cwd() + "/", import.meta.url];
    const miniflarePath = resolveModulePath("miniflare", { from, try: true });
    const workerdPath = resolveModulePath("workerd", { from: miniflarePath || from });
    const { compatibilityDate } = await import(pathToFileURL(workerdPath).href);
    if (!_isDateString(compatibilityDate)) {
      return undefined;
    }
    const today = new Date().toISOString().slice(0, 10);
    return compatibilityDate > today ? today : compatibilityDate;
  } catch {
    return undefined;
  }
}

/** First defined date (highest precedence first), capped at `supported` with a warning. */
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
 * Union compat flags with `nodejs_compat` on by default. workerd refuses both
 * `nodejs_compat` and `no_nodejs_compat`, so the user's side of the pair wins.
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

/**
 * Whether user `miniflareOptions` configure persistence (`defaultPersistRoot`,
 * any `*Persist`, or v5's `resourcePersistencePath`).
 */
function hasUserPersistOptions(options: Record<string, unknown>): boolean {
  return Object.keys(options).some(
    (key) =>
      key === "defaultPersistRoot" || key === "resourcePersistencePath" || key.endsWith("Persist"),
  );
}

/** Where `wrangler dev` persists: next to the loaded or requested config, else cwd. */
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

const _isWin = process.platform === "win32";

/**
 * Absolute path of a path key (absolute path or `file:` URL, which workerd has
 * no scheme for), else `undefined`: other keys only match verbatim.
 */
function virtualKeyPath(key: string): string | undefined {
  if (_isWin && /^\/[A-Za-z]:\//.test(key)) {
    // `/D:/app/x.mjs` (see `toWorkerdPath()`)
    key = key.slice(1);
  }
  if (key.startsWith("file:")) {
    try {
      return fileURLToPath(key);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(key) ? resolve(key) : undefined;
}

/**
 * workerd resolves relative specifiers against `/`-separated module names, so
 * on Windows spell `D:\app\x.mjs` as `/D:/app/x.mjs` (else `../y.mjs` fails
 * as an invalid specifier). Other paths are returned as is.
 */
function toWorkerdPath(path: string): string {
  return _isWin && /^[A-Za-z]:[\\/]/.test(path) ? "/" + path.replaceAll("\\", "/") : path;
}

type VirtualKeyResolver = (specifier: string, importerPath?: string) => string | undefined;

function createMiniflareVirtualModules(
  sources: Record<string, ServedVirtualModule>,
): MiniflareVirtualModules {
  const virtual = { sources, removed: new Set<string>(), versions: new Map(), version: 0 };
  return refreshVirtualKeyResolvers(virtual as MiniflareVirtualModules);
}

/** Rebuild the resolvers after keys were added or removed. */
function refreshVirtualKeyResolvers(virtual: MiniflareVirtualModules): MiniflareVirtualModules {
  const keys = Object.keys(virtual.sources);
  virtual.keyOf = createVirtualKeyResolver(keys);
  virtual.versionedKeyOf =
    virtual.removed.size > 0
      ? createVirtualKeyResolver([...keys, ...virtual.removed])
      : virtual.keyOf;
  return virtual;
}

/**
 * Virtual key an import specifier refers to, resolved like workerd: verbatim
 * (query stripped), else by path for path keys. Relative specifiers join onto
 * the importer's path as plain text (workerd doesn't percent-decode them).
 */
function createVirtualKeyResolver(keys: Iterable<string>): VirtualKeyResolver {
  const verbatim = new Set(keys);
  const pathKeys = new Map<string, string>();
  for (const key of verbatim) {
    const path = virtualKeyPath(key);
    if (path !== undefined) {
      pathKeys.set(path, key);
    }
  }
  return (specifier, importerPath) => {
    const clean = specifier.split("?")[0]!;
    if (verbatim.has(clean)) {
      return clean;
    }
    if (pathKeys.size === 0) {
      return undefined;
    }
    const path = /^\.\.?\//.test(clean)
      ? importerPath && resolve(dirname(importerPath), clean)
      : virtualKeyPath(clean);
    return path ? pathKeys.get(path) : undefined;
  };
}

/** `key => importer keys` from the import specifiers of virtual sources. */
function virtualImporters(
  virtual: Record<string, ServedVirtualModule>,
  keyOf: ReturnType<typeof createVirtualKeyResolver>,
): Map<string, Set<string>> {
  const importers = new Map<string, Set<string>>();
  for (const [importer, { source, format }] of Object.entries(virtual)) {
    // Only ES modules: CommonJS `require()` specifiers aren't versioned.
    if (format !== "module") {
      continue;
    }
    const importerPath = virtualKeyPath(importer);
    for (const { specifier } of versionableImports(source as string) ?? []) {
      const key = keyOf(specifier, importerPath);
      if (key !== undefined && key !== importer) {
        let set = importers.get(key);
        if (!set) {
          importers.set(key, (set = new Set()));
        }
        set.add(importer);
      }
    }
  }
  return importers;
}

/**
 * Static imports/re-exports and literal dynamic imports, with the offset to
 * append a query at; `undefined` for unparsable code.
 */
function versionableImports(code: string): { specifier: string; end: number }[] | undefined {
  let imports: ReturnType<typeof parseEsm>[0];
  try {
    [imports] = parseEsm(code);
  } catch {
    return undefined;
  }
  const result: { specifier: string; end: number }[] = [];
  for (const imp of imports) {
    // A template-literal dynamic import with substitutions is reported as a
    // glob specifier (each `${...}` collapsed to `*`), never a real key.
    if (typeof imp.specifier !== "string" || (imp.type === "dynamic" && imp.glob)) {
      continue;
    }
    // Static import/re-export offsets exclude the quotes; dynamic import
    // offsets span the full specifier expression including them.
    result.push({ specifier: imp.specifier, end: imp.type === "dynamic" ? imp.end - 1 : imp.end });
  }
  return result;
}

/**
 * Rewrite imports of invalidated virtual modules (`#config.json?v=2`): workerd
 * caches by name, so the new name misses and the fallback serves fresh source.
 */
function applyVirtualVersions(
  code: string,
  versions: ReadonlyMap<string, number>,
  keyOf: (specifier: string) => string | undefined,
): string {
  if (versions.size === 0) {
    return code;
  }
  // Unparsable code is served untouched — workerd reports its own error.
  const imports = versionableImports(code);
  if (!imports) {
    return code;
  }
  let out = "";
  let last = 0;
  for (const { specifier, end } of imports) {
    const key = keyOf(specifier);
    const version = key === undefined ? undefined : versions.get(key);
    if (!version) {
      continue;
    }
    out += code.slice(last, end) + (specifier.includes("?") ? "&" : "?") + `v=${version}`;
    last = end;
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

/** Named exports of CommonJS code (cjs-module-lexer, like Node); none if it can't be lexed. */
function commonJSExports(contents: string): string[] {
  try {
    return parseCjs(contents).exports;
  } catch {
    return [];
  }
}

function createCjsEsmShim(cjsSpecifier: string, contents: string): string {
  const namedExports = commonJSExports(contents).filter(
    (e) => e !== "default" && e !== "__esModule",
  );
  const quoted = JSON.stringify(cjsSpecifier);
  let shim = `import __cjs_mod__ from ${quoted};\nexport default __cjs_mod__;\n`;
  for (const name of namedExports) {
    shim += `export var ${name} = __cjs_mod__["${name}"];\n`;
  }
  return shim;
}

// #endregion
