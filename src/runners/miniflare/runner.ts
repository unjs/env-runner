import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as MiniflareEnvRunnerData } from "../../common/base-runner.ts";

export interface MiniflareEnvRunnerOptions {
  name: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /** Options passed directly to the Miniflare constructor. */
  miniflareOptions?: Record<string, unknown>;
}

const IPC_HEADER = "x-env-runner-ipc";

export class MiniflareEnvRunner extends BaseEnvRunner {
  #miniflare?: InstanceType<any>;
  #miniflareOptions: Record<string, unknown>;
  #reloadCounter = 0;

  constructor(opts: MiniflareEnvRunnerOptions) {
    super({ ...opts, workerEntry: "" });
    this.#miniflareOptions = opts.miniflareOptions || {};
    this.#init();
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.#miniflare || this.closed) {
      return new Response("miniflare env runner is unavailable", { status: 503 });
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return this.#miniflare.dispatchFetch(url, init) as Promise<Response>;
  }

  sendMessage(message: unknown) {
    if (!this.#miniflare) {
      throw new Error("Miniflare env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally
    if ((message as any)?.type === "ping") {
      queueMicrotask(() => this._handleMessage({ type: "pong", data: (message as any).data }));
      return;
    }
    // Send message to worker via dispatchFetch with IPC header
    this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "message" },
        body: JSON.stringify(message),
      })
      .catch(() => {});
  }

  /**
   * Hot-reload the user entry module without recreating the Miniflare instance.
   *
   * Uses `unsafeEvalBinding` to dynamically re-import the entry module with a
   * cache-busting query string, served via `unsafeModuleFallbackService`.
   */
  async reloadModule(): Promise<void> {
    if (!this.#miniflare) {
      throw new Error("Miniflare env runner should be initialized before reloading.");
    }
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      return;
    }
    this.#reloadCounter++;
    await this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "reload" },
        body: String(this.#reloadCounter),
      })
      .catch(() => {});
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
    // Notify worker of shutdown
    await this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "shutdown" },
      })
      .catch(() => {});
    await this.#miniflare.dispose();
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

    const options: Record<string, unknown> = {
      compatibilityDate: new Date().toISOString().split("T")[0],
      modules: true,
      ...this.#miniflareOptions,
    };

    // Inject IPC service binding (worker → runner outbound messages)
    const existingBindings = (options.serviceBindings as Record<string, unknown>) || {};
    options.serviceBindings = {
      ...existingBindings,
      __ENV_RUNNER_IPC: async (request: Request) => {
        const message = await request.json().catch(() => null);
        if (message !== null) {
          this._handleMessage(message);
        }
        return new Response(null, { status: 204 });
      },
    };

    // Generate in-memory wrapper module with IPC support
    if (entryPath && !options.script && !options.scriptPath) {
      const resolvedEntry = resolve(entryPath);
      const entryDir = dirname(resolvedEntry);

      options.script = generateWrapper(resolvedEntry);
      // Set scriptPath to entry's directory so workerd resolves imports correctly
      options.scriptPath = entryDir + "/__env_runner_wrapper.mjs";

      // Enable unsafeEval for hot-reload support (re-import entry without restart)
      options.unsafeEvalBinding = "__ENV_RUNNER_UNSAFE_EVAL__";

      // Module fallback: resolve imports that workerd can't find on its own
      // (e.g. imports from node_modules, parent dirs, cache-busted reload imports)
      if (!options.unsafeModuleFallbackService) {
        options.unsafeUseModuleFallbackService = true;
        options.unsafeModuleFallbackService = (request: Request) => {
          const url = new URL(request.url);
          const specifier = url.searchParams.get("specifier");
          if (!specifier) {
            return new Response(null, { status: 404 });
          }
          // Strip cache-busting query string (?t=...)
          const cleanSpecifier = specifier.split("?")[0] || specifier;
          // Resolve relative to the entry directory
          const resolvedPath = cleanSpecifier.startsWith("/")
            ? cleanSpecifier
            : resolve(entryDir, cleanSpecifier);
          try {
            const contents = readFileSync(resolvedPath, "utf8");
            const name = posix.relative("/", specifier);
            return Response.json({ name, esModule: contents });
          } catch {
            return new Response(null, { status: 404 });
          }
        };
      }
    }

    this.#miniflare = new Miniflare(options);

    await this.#miniflare.ready;

    // Trigger IPC init (calls onOpen in the worker)
    await this.#miniflare
      .dispatchFetch("http://localhost/__env_runner_ipc", {
        method: "POST",
        headers: { [IPC_HEADER]: "init" },
      })
      .catch(() => {});

    // Signal ready with a dummy address (fetch is overridden)
    this._handleMessage({ address: { host: "127.0.0.1", port: 0 } });
  }

  // #endregion
}

// #region Helpers

/**
 * Generates a wrapper module that imports the user entry and adds IPC glue.
 *
 * The user module is expected to export `fetch` and optionally `ipc`.
 * The wrapper intercepts IPC requests and bridges `ipc` hooks
 * via `env.__ENV_RUNNER_IPC` service binding.
 *
 * Supports hot-reload via `unsafeEvalBinding`: the "reload" IPC message
 * uses dynamic `import()` with a cache-busting query string to re-import
 * the entry module (served fresh by `unsafeModuleFallbackService`).
 *
 * Passed as an in-memory `script` to Miniflare (no temp files needed).
 */
function generateWrapper(entryPath: string): string {
  // Use ./ relative path since scriptPath is set to entry's directory
  const importPath = "./" + entryPath.split("/").pop();
  return `import * as __userModule from ${JSON.stringify(importPath)};

let __userEntry = __userModule.default || __userModule;
const __IPC_HEADER = "${IPC_HEADER}";
const __entryPath = ${JSON.stringify(entryPath)};
let __ipcInitialized = false;
let __sendMessage;

// Re-export user module's named exports
export * from ${JSON.stringify(importPath)};

export default {
  async fetch(request, env, ctx) {
    const ipcType = request.headers.get(__IPC_HEADER);
    if (ipcType) {
      if (ipcType === "init") {
        if (!__ipcInitialized && __userEntry.ipc && env.__ENV_RUNNER_IPC) {
          __ipcInitialized = true;
          __sendMessage = (message) => {
            env.__ENV_RUNNER_IPC.fetch("http://ipc/", {
              method: "POST",
              body: JSON.stringify(message),
            });
          };
          if (__userEntry.ipc.onOpen) {
            await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
          }
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "message") {
        const message = await request.json();
        if (__userEntry.ipc?.onMessage) {
          __userEntry.ipc.onMessage(message);
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "shutdown") {
        if (__userEntry.ipc?.onClose) {
          await __userEntry.ipc.onClose();
        }
        return new Response(null, { status: 204 });
      }
      if (ipcType === "reload" && env.__ENV_RUNNER_UNSAFE_EVAL__) {
        const version = await request.text();
        try {
          // Re-import with cache-busting query to get fresh module from fallback service
          const importFn = env.__ENV_RUNNER_UNSAFE_EVAL__.newAsyncFunction(
            "return await import(path)",
            "reload",
            "path"
          );
          const freshModule = await importFn(__entryPath + "?t=" + version);
          const newEntry = freshModule.default || freshModule;
          // Notify old entry of close
          if (__userEntry.ipc?.onClose) {
            await __userEntry.ipc.onClose();
          }
          __userEntry = newEntry;
          // Re-init IPC on the new entry
          if (__userEntry.ipc?.onOpen && __sendMessage) {
            await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
          }
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 400 });
    }
    const entryFetch = __userEntry.fetch;
    if (!entryFetch) {
      return new Response("No fetch handler exported", { status: 500 });
    }
    return entryFetch(request, env, ctx);
  }
};
`;
}

// #endregion
