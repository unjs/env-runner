import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RunnerMessageListener, EnvRunner, WorkerAddress, WorkerHooks } from "../types.ts";

import { rm } from "node:fs/promises";
import { proxyFetch, proxyUpgrade } from "httpxy";
import { isCI, isTest } from "std-env";

export interface EnvRunnerData {
  name?: string;
  [key: string]: unknown;
}

export abstract class BaseEnvRunner implements EnvRunner {
  closed: boolean = false;

  protected _name: string;
  protected _workerEntry: string;
  protected _data?: EnvRunnerData;
  protected _hooks: Partial<WorkerHooks>;
  protected _address?: WorkerAddress;
  protected _messageListeners: Set<(data: unknown) => void>;

  constructor(opts: {
    name: string;
    workerEntry: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    this._name = opts.name;
    this._workerEntry = opts.workerEntry;
    this._data = opts.data;
    this._hooks = opts.hooks || {};
    this._messageListeners = new Set();
  }

  get ready() {
    return Boolean(!this.closed && this._address && this._hasRuntime());
  }

  // #region Public methods

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    for (let i = 0; i < 5 && !this._address && !this.closed; i++) {
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i)));
    }
    if (!this._address) {
      return new Response(`${this._runtimeType()} env runner is unavailable`, {
        status: 503,
      });
    }
    return proxyFetch(this._address, input, init);
  }

  async upgrade(context: { node: { req: IncomingMessage; socket: Socket; head: any } }) {
    if (!this.ready || !this._address) {
      return;
    }
    await proxyUpgrade(this._address, context.node.req, context.node.socket, context.node.head);
  }

  abstract sendMessage(message: unknown): void;

  onMessage(listener: RunnerMessageListener) {
    this._messageListeners.add(listener);
  }

  offMessage(listener: RunnerMessageListener) {
    this._messageListeners.delete(listener);
  }

  async close(cause?: unknown) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._hooks.onClose?.(this, cause);
    this._hooks = {};
    const onError = (error: unknown) => console.error(error);
    await this._closeRuntime().catch(onError);
    await this._closeSocket().catch(onError);
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    // eslint-disable-next-line unicorn/no-nested-ternary
    const status = this.closed ? "closed" : this.ready ? "ready" : "pending";
    return `${this.constructor.name}#${this._name}(${status})`;
  }

  // #endregion

  // #region Protected methods

  protected _handleMessage(message: any) {
    if (message?.address) {
      this._address = message.address;
      this._hooks.onReady?.(this, this._address);
    }
    for (const listener of this._messageListeners) {
      listener(message);
    }
  }

  protected async _closeSocket() {
    const socketPath = this._address?.socketPath;
    if (socketPath && socketPath[0] !== "\0" && !socketPath.startsWith(String.raw`\\.\\pipe`)) {
      await rm(socketPath).catch(() => {});
    }
    this._address = undefined;
  }

  protected async _requestGracefulShutdown(
    sendShutdown: () => void,
    listenForExit: (resolve: () => void) => void,
    hasExited: () => boolean,
  ) {
    sendShutdown();
    if (!hasExited() && !isTest && !isCI) {
      await new Promise<void>((resolve) => {
        const gracefulShutdownTimeoutMs =
          Number.parseInt(process.env.ENV_RUNNER_SHUTDOWN_TIMEOUT || "", 10) || 5000;
        const timeout = setTimeout(() => {
          console.warn(`force closing node env runner ${this._runtimeType()}...`);
          resolve();
        }, gracefulShutdownTimeoutMs);
        listenForExit(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  // #endregion

  // #region Abstract methods

  protected abstract _hasRuntime(): boolean;
  protected abstract _closeRuntime(): Promise<void>;

  protected abstract _runtimeType(): string;

  // #endregion
}
