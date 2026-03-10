import type { WorkerHooks } from "../../types.ts";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData };

let _defaultEntry: string;

export class NodeWorkerEnvRunner extends BaseEnvRunner {
  #worker?: Worker & { _exitCode?: number };

  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/node-worker/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
    this.#initWorker();
  }

  sendMessage(message: unknown) {
    if (!this.#worker) {
      throw new Error("Node env worker should be initialized before sending messages.");
    }
    this.#worker.postMessage(message);
  }

  // #region Protected methods

  protected _hasRuntime() {
    return Boolean(this.#worker);
  }

  protected _runtimeType() {
    return "worker";
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
