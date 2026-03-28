import type { WorkerHooks } from "../../types.ts";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as DenoProcessEnvRunnerData } from "../../common/base-runner.ts";

let _defaultEntry: string;

interface ProcessHandle {
  pid: number;
  kill: () => void;
  send: (message: unknown) => void;
  exited: Promise<number>;
  _exitCode?: number | null;
  removeAllListeners?: () => void;
}

export class DenoProcessEnvRunner extends BaseEnvRunner {
  #process?: ProcessHandle;

  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
    execArgv?: string[];
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/deno-process/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
    this.#initProcess(opts.execArgv);
  }

  sendMessage(message: unknown) {
    if (!this.#process) {
      throw new Error("Deno env process should be initialized before sending messages.");
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
    this.#process.removeAllListeners?.();
    try {
      this.#process.kill();
    } catch {}
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

    const child = spawn(
      "deno",
      ["run", "-A", "--node-modules-dir=auto", "--no-lock", ...(execArgv || []), this._workerEntry],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
    });

    const handle: ProcessHandle = {
      pid: child.pid!,
      kill: () => child.kill(),
      send: (message: unknown) => {
        child.stdin!.write(JSON.stringify(message) + "\n");
      },
      exited,
      _exitCode: undefined,
      removeAllListeners: () => child.removeAllListeners(),
    };

    child.once("exit", (code) => {
      handle._exitCode = code;
      this.close(`process exited with code ${code}`);
    });

    child.on("error", (error) => {
      if (!this.closed) {
        console.error(`Process error:`, error);
        this.close(error);
      }
    });

    // Parse newline-delimited JSON from stdout for IPC
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith("{")) {
          try {
            this._handleMessage(JSON.parse(line));
          } catch {
            // Not JSON, ignore
          }
        }
      }
    });

    this.#process = handle;
  }

  // #endregion
}
