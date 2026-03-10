import type { WorkerHooks } from "../../types.ts";

import { readFileSync } from "node:fs";
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

    // Generate wrapper script with IPC support
    if (entryPath && !options.script) {
      const userCode = readFileSync(entryPath, "utf8");
      options.script = wrapScript(userCode);
      delete options.scriptPath;
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
 * Wraps user module code with IPC glue.
 *
 * The user module is expected to `export default { fetch, ipc? }`.
 * The wrapper renames the user's default export, intercepts IPC requests,
 * and bridges the `ipc` hooks via `env.__ENV_RUNNER_IPC` service binding.
 */
function wrapScript(userCode: string): string {
  // Replace `export default` with a variable assignment so we can wrap it
  const transformed = userCode.replace(/export\s+default\s+/, "const __userEntry = ");

  return `${transformed}

// --- env-runner IPC glue ---
let __ipcInitialized = false;
const __IPC_HEADER = "${IPC_HEADER}";

export default {
  async fetch(request, env, ctx) {
    // Handle IPC control messages from runner
    const ipcType = request.headers.get(__IPC_HEADER);
    if (ipcType) {
      if (ipcType === "init") {
        if (!__ipcInitialized && __userEntry.ipc && env.__ENV_RUNNER_IPC) {
          __ipcInitialized = true;
          const sendMessage = (message) => {
            env.__ENV_RUNNER_IPC.fetch("http://ipc/", {
              method: "POST",
              body: JSON.stringify(message),
            });
          };
          if (__userEntry.ipc.onOpen) {
            await __userEntry.ipc.onOpen({ sendMessage });
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
      return new Response(null, { status: 400 });
    }

    // Delegate to user's fetch handler
    return __userEntry.fetch(request, env, ctx);
  }
};
`;
}

// #endregion
