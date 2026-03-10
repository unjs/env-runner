import type { WorkerHooks } from "../../types.ts";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData };

let _defaultEntry: string;

export class VercelEnvRunner extends BaseEnvRunner {
  #worker?: Worker & { _exitCode?: number };

  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/vercel/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
    this.#initWorker();
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    // x-vercel-deployment-url: the worker server's own URL
    if (this._address && this._address.port != null && !headers.has("x-vercel-deployment-url")) {
      const host = this._address.host || "127.0.0.1";
      headers.set("x-vercel-deployment-url", `http://${host}:${this._address.port}`);
    }

    // Client IP from existing forwarding headers or default to 127.0.0.1
    const clientIp =
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers.get("x-real-ip") ||
      "127.0.0.1";

    if (!headers.has("x-vercel-forwarded-for")) {
      headers.set("x-vercel-forwarded-for", clientIp);
    }
    if (!headers.has("x-forwarded-for")) {
      headers.set("x-forwarded-for", clientIp);
    }
    if (!headers.has("x-real-ip")) {
      headers.set("x-real-ip", clientIp);
    }

    // Standard forwarding headers
    try {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!headers.has("x-forwarded-proto")) {
        headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
      }
      if (!headers.has("x-forwarded-host")) {
        headers.set("x-forwarded-host", headers.get("host") || url.host);
      }
    } catch {
      // URL parsing failed, skip proto/host headers
    }

    if (input instanceof Request) {
      return super.fetch(new Request(input, { headers }));
    }
    return super.fetch(input, { ...init, headers });
  }

  sendMessage(message: unknown) {
    if (!this.#worker) {
      throw new Error("Vercel env worker should be initialized before sending messages.");
    }
    this.#worker.postMessage(message);
  }

  // #region Protected methods

  protected _hasRuntime() {
    return Boolean(this.#worker);
  }

  protected _runtimeType() {
    return "vercel";
  }

  protected async _closeRuntime() {
    if (!this.#worker) {
      return;
    }
    await this._requestGracefulShutdown(
      () => this.#worker!.postMessage({ event: "shutdown" }),
      (resolve) => {
        this.#worker?.on("message", (message) => {
          if (message.event === "exit") {
            resolve();
          }
        });
      },
      () => Boolean(this.#worker?._exitCode),
    );
    this.#worker.removeAllListeners();
    await this.#worker.terminate().catch((error) => {
      console.error(error);
    });
    this.#worker = undefined;
  }

  // #endregion

  // #region Private methods

  #initWorker() {
    if (!existsSync(this._workerEntry)) {
      this.close(`worker entry not found in "${this._workerEntry}".`);
      return;
    }

    const worker = new Worker(this._workerEntry, {
      env: {
        ...process.env,
      },
      workerData: {
        name: this._name,
        ...this._data,
      },
    }) as Worker & { _exitCode?: number };

    worker.once("exit", (code) => {
      worker._exitCode = code;
      this.close(`worker exited with code ${code}`);
    });

    worker.once("error", (error) => {
      console.error(`Worker error:`, error);
      this.close(error);
    });

    worker.on("message", (message) => {
      this._handleMessage(message);
    });

    this.#worker = worker;
  }

  // #endregion
}
