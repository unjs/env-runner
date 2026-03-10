import type { WorkerHooks } from "../../types.ts";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as BunProcessEnvRunnerData } from "../../common/base-runner.ts";

let _defaultEntry: string;

interface ProcessHandle {
  pid: number;
  kill: () => void;
  send: (message: unknown) => void;
  exited: Promise<number>;
  _exitCode?: number | null;
  removeAllListeners?: () => void;
}

// @ts-expect-error Bun global
const _isBun = typeof Bun !== "undefined";

export class BunProcessEnvRunner extends BaseEnvRunner {
  #process?: ProcessHandle;

  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
    execArgv?: string[];
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/bun-process/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
    this.#initProcess(opts.execArgv);
  }

  sendMessage(message: unknown) {
    if (!this.#process) {
      throw new Error("Bun env process should be initialized before sending messages.");
    }
    this.#process.send(message);
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
        this.#process?.exited.then(() => resolve());
      },
      () => this.#process?._exitCode != null,
    );
    this.#process.removeAllListeners?.();
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

    const env = {
      ...process.env,
      ENV_RUNNER_NAME: this._name,
      ENV_RUNNER_DATA: JSON.stringify(this._data || {}),
    };

    if (_isBun) {
      this.#initBunProcess(execArgv, env);
    } else {
      this.#initNodeProcess(execArgv, env);
    }
  }

  #initBunProcess(execArgv: string[] | undefined, env: Record<string, string | undefined>) {
    // @ts-expect-error Bun global
    const proc = Bun.spawn({
      cmd: ["bun", ...(execArgv || []), this._workerEntry],
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ipc: (message: any) => {
        this._handleMessage(message);
      },
    });

    const child: ProcessHandle = {
      pid: proc.pid,
      kill: () => proc.kill(),
      send: (message: unknown) => proc.send(message),
      exited: proc.exited,
      _exitCode: undefined,
    };

    proc.exited.then((code: number) => {
      child._exitCode = code;
      this.close(`process exited with code ${code}`);
    });

    this.#process = child;
  }

  #initNodeProcess(execArgv: string[] | undefined, env: Record<string, string | undefined>) {
    // Spawn a Bun child process even when the host is Node.js
    const child = spawn("bun", [...(execArgv || []), this._workerEntry], {
      env,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
    });

    const handle: ProcessHandle = {
      pid: child.pid!,
      kill: () => child.kill(),
      send: (message: unknown) => child.send(message as any),
      exited,
      _exitCode: undefined,
      removeAllListeners: () => child.removeAllListeners(),
    };

    child.once("exit", (code) => {
      handle._exitCode = code;
      this.close(`process exited with code ${code}`);
    });

    child.once("error", (error) => {
      console.error(`Process error:`, error);
      this.close(error);
    });

    child.on("message", (message: any) => {
      this._handleMessage(message);
    });

    this.#process = handle;
  }

  // #endregion
}
