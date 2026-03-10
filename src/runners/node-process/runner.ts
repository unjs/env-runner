import type { WorkerHooks } from "../../types.ts";

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as ProcessEnvRunnerData } from "../../common/base-runner.ts";

let _defaultEntry: string;

export class NodeProcessEnvRunner extends BaseEnvRunner {
  #process?: ChildProcess & { _exitCode?: number | null };

  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
    execArgv?: string[];
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/node-process/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
    this.#initProcess(opts.execArgv);
  }

  sendMessage(message: unknown) {
    if (!this.#process) {
      throw new Error("Node env process should be initialized before sending messages.");
    }
    this.#process.send(message as any);
  }

  // #region Protected methods

  protected _hasRuntime() {
    return Boolean(this.#process);
  }

  protected _runtimeType() {
    return "process";
  }

  protected async _closeRuntime() {
    if (!this.#process) {
      return;
    }
    await this._requestGracefulShutdown(
      () => this.#process!.send({ event: "shutdown" }),
      (resolve) => {
        this.#process?.on("message", (message: any) => {
          if (message.event === "exit") {
            resolve();
          }
        });
      },
      () => this.#process?._exitCode != null,
    );
    this.#process.removeAllListeners();
    this.#process.kill();
    this.#process = undefined;
  }

  // #endregion

  // #region Private methods

  #initProcess(execArgv?: string[]) {
    if (!existsSync(this._workerEntry)) {
      this.close(`process entry not found in "${this._workerEntry}".`);
      return;
    }

    const child = fork(this._workerEntry, [], {
      env: {
        ...process.env,
        ENV_RUNNER_NAME: this._name,
        ENV_RUNNER_DATA: JSON.stringify(this._data || {}),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: execArgv || [],
    }) as ChildProcess & { _exitCode?: number | null };

    child.once("exit", (code) => {
      child._exitCode = code;
      this.close(`process exited with code ${code}`);
    });

    child.once("error", (error) => {
      console.error(`Process error:`, error);
      this.close(error);
    });

    child.on("message", (message: any) => {
      this._handleMessage(message);
    });

    this.#process = child;
  }

  // #endregion
}
