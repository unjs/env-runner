import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import { generateWrapper } from "./wrapper.ts";

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
}

const IPC_PATH = "/__env_runner_ipc";

// Module-level cache for persistent Miniflare instances
const _miniflareCache = new Map<string, { mf: InstanceType<any>; refCount: number }>();

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #transformRequest?: (id: string) => Promise<TransformResult | null | undefined>;
  #reloadCounter = 0;
  #ws?: { send(data: string): void; close(): void };
  #persistent: boolean;
  #cacheKey?: string;
  #exports: Record<string, MiniflareExportInfo> | boolean;
  #captureErrors: boolean;

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareOptions = opts.miniflareOptions || {};
    this.#transformRequest = opts.transformRequest;
    this.#persistent = opts.persistent ?? false;
    this.#exports = opts.exports ?? {};
    this.#captureErrors = opts.captureErrors ?? true;
    this.#init();
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
      if (this.#cacheKey) {
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
    if (!this.#miniflare || this.closed) {
      return new Response("miniflare env runner is unavailable", { status: 503 });
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
    const version = this.#reloadCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Module reload timed out"));
      }, timeout);
      const listener = (msg: any) => {
        if (msg?.event === "module-reloaded") {
          cleanup();
          if (msg.error) {
            reject(typeof msg.error === "string" ? new Error(msg.error) : msg.error);
          } else {
            resolve();
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.offMessage(listener);
      };
      this.onMessage(listener);
      this.#ws!.send(JSON.stringify({ type: "reload", version }));
    });
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
    if (this.#persistent && this.#cacheKey) {
      const cached = _miniflareCache.get(this.#cacheKey);
      if (cached) {
        cached.refCount--;
        if (cached.refCount <= 0) {
          _miniflareCache.delete(this.#cacheKey);
          await this.#miniflare.dispose();
        }
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

  async #initAsync() {
    const { Miniflare } = await import("miniflare");

    const entryPath = this._data?.entry as string | undefined;

    const userFlags = (this.#miniflareOptions.compatibilityFlags as string[]) || [];
    const options: Record<string, unknown> = {
      compatibilityDate: new Date().toISOString().split("T")[0],
      modules: true,
      ...this.#miniflareOptions,
      compatibilityFlags: [...new Set(["nodejs_compat", ...userFlags])],
    };

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      const resolvedEntry = resolve(entryPath);
      const entryDir = dirname(resolvedEntry);

      // Auto-detect exported classes from entry file (opt-in)
      const detectedExports =
        this.#exports === false || this.#exports === undefined
          ? []
          : detectExportedClasses(
              resolvedEntry,
              typeof this.#exports === "object" ? this.#exports : {},
            );

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
        const _require = createRequire(resolvedEntry);
        const _transformRequest = this.#transformRequest;
        options.unsafeUseModuleFallbackService = true;
        // Map workerd module names to real filesystem paths for correct
        // relative import resolution from bare-specifier modules.
        const modulePathMap = new Map<string, string>();
        options.unsafeModuleFallbackService = async (request: Request) => {
          const url = new URL(request.url);
          const specifier = url.searchParams.get("specifier");
          const rawSpecifier = url.searchParams.get("rawSpecifier");
          const referrer = url.searchParams.get("referrer") || "";
          if (!specifier) {
            return new Response(null, { status: 404 });
          }
          const cleanSpecifier = specifier.split("?")[0] || specifier;
          const cleanRaw = rawSpecifier?.split("?")[0];
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
                resolvedPath = contextRequire.resolve(cleanRaw);
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
                return Response.json({ name, esModule: result.code });
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
            return Response.json({
              name,
              ...(isESM ? { esModule: contents } : { commonJsModule: contents }),
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        };
      }
    }

    // Persistent Miniflare: reuse cached instance if available
    if (this.#persistent && entryPath) {
      this.#cacheKey = computeCacheKey(entryPath, this.#miniflareOptions);
      const cached = _miniflareCache.get(this.#cacheKey);
      if (cached) {
        this.#miniflare = cached.mf;
        cached.refCount++;
      }
    }

    if (!this.#miniflare) {
      this.#miniflare = new Miniflare(options);
      await this.#miniflare.ready;
      if (this.#persistent && this.#cacheKey) {
        _miniflareCache.set(this.#cacheKey, { mf: this.#miniflare, refCount: 1 });
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
 * Detect `export class` declarations in the entry file.
 * Merges with explicitly declared exports from options.
 */
function detectExportedClasses(
  entryPath: string,
  explicit: Record<string, MiniflareExportInfo>,
): string[] {
  const names = new Set(Object.keys(explicit));
  try {
    const source = readFileSync(entryPath, "utf8");
    const re = /\bexport\s+class\s+(\w+)/g;
    let match;
    while ((match = re.exec(source))) {
      if (match[1]) names.add(match[1]);
    }
  } catch {
    // Entry might not exist yet (e.g. generated at build time)
  }
  return [...names];
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

// #endregion
