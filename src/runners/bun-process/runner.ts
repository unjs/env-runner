import type { WorkerHooks } from "../../types.ts";

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import { createLazyEnvProxy } from "../../common/lazy-env.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";

export type { EnvRunnerData as BunProcessEnvRunnerData } from "../../common/base-runner.ts";

let _defaultEntry: string;
let _bunPath: string | undefined;

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

/** Resolve the Bun executable path from common install locations or PATH. */
function resolveBunPath(): string {
  if (_bunPath) return _bunPath;
  // Check common locations
  const candidates = [join(homedir(), ".bun", "bin", "bun")];
  for (const p of candidates) {
    if (existsSync(p)) {
      return (_bunPath = p);
    }
  }
  // Try to find via `which`
  try {
    const resolved = execSync("which bun", { encoding: "utf8" }).trim();
    if (resolved) return (_bunPath = resolved);
  } catch {}
  // Fallback to bare "bun" and hope PATH has it
  return (_bunPath = "bun");
}

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

  /** Send a user message to the active process runtime. */
  sendMessage(message: unknown) {
    if (!this.#process) {
      throw new Error("Bun env process should be initialized before sending messages.");
    }
    this.#process.send(message);
  }

  // #region Protected methods

  /** Whether an underlying runtime process handle is currently active. */
  protected _hasRuntime() {
    return Boolean(this.#process);
  }

  /** Runtime kind used for diagnostics and inspect output. */
  protected _runtimeType() {
    return "process";
  }

  /** Terminate and detach the active process handle. */
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

  /** Initialize either Bun-native IPC spawn or Node child-process fallback. */
  #initProcess(execArgv?: string[]) {
    if (!existsSync(this._workerEntry)) {
      this.close(`process entry not found in "${this._workerEntry}".`);
      return;
    }

    const env = createLazyEnvProxy({
      ENV_RUNNER_NAME: this._name,
      ENV_RUNNER_DATA: JSON.stringify(this._data || {}),
    });

    if (_isBun) {
      this.#initBunProcess(execArgv, env);
    } else {
      this.#initNodeProcess(execArgv, env);
    }
  }

  /** Start a Bun process with Bun IPC callback wiring. */
  #initBunProcess(execArgv: string[] | undefined, env: NodeJS.ProcessEnv) {
    // @ts-expect-error Bun global
    const proc = Bun.spawn({
      cmd: [resolveBunPath(), ...(execArgv || []), this._workerEntry],
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

  /** Start a Bun child process via Node spawn and stdio IPC channel. */
  #initNodeProcess(execArgv: string[] | undefined, env: NodeJS.ProcessEnv) {
    // Spawn a Bun child process even when the host is Node.js
    const child = spawn(resolveBunPath(), [...(execArgv || []), this._workerEntry], {
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

    child.on("error", (error) => {
      if (!this.closed) {
        console.error(`Process error:`, error);
        this.close(error);
      }
    });

    child.on("message", (message: any) => {
      this._handleMessage(message);
    });

    this.#process = handle;
  }

  // #endregion
}
