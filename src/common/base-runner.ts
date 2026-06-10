import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RunnerMessageListener, EnvRunner, WorkerAddress, WorkerHooks } from "../types.ts";

import { rm } from "node:fs/promises";
import { proxyFetch, proxyUpgrade } from "httpxy";
import { resolveVirtualModules } from "../virtual-loader.ts";
import type { VirtualModules } from "../virtual-loader.ts";

export type { VirtualModules, VirtualModuleSource } from "../virtual-loader.ts";

export interface EnvRunnerData {
  name?: string;

  /**
   * Virtual modules as a `specifier => source` map.
   *
   * Registered as Node.js ESM customization hooks in the worker so the entry
   * (and its dependencies) can `import` them, e.g.
   * `{ "#virtual-import": "export const foo = 1" }`.
   *
   * Each source may be a string or a factory `() => string | Promise<string>`.
   * Factories are evaluated once on the host before the worker is spawned (so the
   * worker always receives plain strings).
   *
   * Supported by the `node-worker`, `node-process`, `bun-process`,
   * `deno-process`, `vercel`, `netlify`, and `miniflare` runners.
   */
  virtual?: VirtualModules;

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

  waitForReady(timeout = 5000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("Runner closed before becoming ready"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._messageListeners.delete(listener);
        reject(new Error("Runner did not become ready in time"));
      }, timeout);
      const listener = () => {
        if (this.ready) {
          clearTimeout(timer);
          this._messageListeners.delete(listener);
          resolve();
        } else if (this.closed) {
          clearTimeout(timer);
          this._messageListeners.delete(listener);
          reject(new Error("Runner closed before becoming ready"));
        }
      };
      this._messageListeners.add(listener);
    });
  }

  rpc<T = unknown>(name: string, data?: unknown, opts?: { timeout?: number }): Promise<T> {
    const id = Math.random().toString(36).slice(2);
    const timeout = opts?.timeout ?? 3000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC "${name}" timed out`));
      }, timeout);
      const listener = (msg: any) => {
        if (msg?.__rpc_id === id) {
          cleanup();
          if (msg.error) {
            reject(typeof msg.error === "string" ? new Error(msg.error) : msg.error);
          } else {
            resolve(msg.data as T);
          }
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.offMessage(listener);
      };
      this.onMessage(listener);
      this.sendMessage({ __rpc: name, __rpc_id: id, data });
    });
  }

  async reloadModule(timeout = 5000): Promise<void> {
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
      this.sendMessage({ event: "reload-module" });
    });
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
    // Workers report a failed init (virtual module registration, entry import)
    // with `init-error` before exiting, so the runner closes with a meaningful
    // cause instead of a bare "process exited with code 1".
    if (message?.event === "init-error" && !this.ready && !this.closed) {
      this.close(new Error(String(message.error || "Worker initialization failed")));
    }
    for (const listener of this._messageListeners) {
      listener(message);
    }
  }

  /**
   * Resolve any factory-valued `data.virtual` sources to strings before the
   * worker is spawned. Returns a pending promise only when there is async work
   * to do (a factory is present); otherwise returns `undefined` so subclasses can
   * keep their synchronous spawn path. Factories must be resolved here because
   * functions can't cross the worker boundary and the load hook can't await.
   */
  protected _resolveVirtualData(): Promise<void> | undefined {
    const virtual = this._data?.virtual;
    if (!virtual || !Object.values(virtual).some((v) => typeof v === "function")) {
      return undefined;
    }
    return resolveVirtualModules(virtual).then((resolved) => {
      this._data = { ...this._data, virtual: resolved };
    });
  }

  /**
   * Run a subclass spawn callback after `data.virtual` is resolved.
   * Synchronous when no factory-valued source is present; otherwise defers
   * `init` until factories resolve. A throwing/rejecting factory closes the
   * runner with the error as cause instead of leaving an unhandled rejection.
   */
  protected _initWithVirtualData(init: () => void): void {
    const pending = this._resolveVirtualData();
    if (pending) {
      pending.then(
        () => {
          if (!this.closed) init();
        },
        (error) => this.close(error),
      );
    } else {
      init();
    }
  }

  protected async _closeSocket() {
    const socketPath = this._address?.socketPath;
    if (socketPath && socketPath[0] !== "\0" && !socketPath.startsWith(String.raw`\\.\\pipe`)) {
      await rm(socketPath).catch(() => {});
    }
    this._address = undefined;
  }

  // #endregion

  // #region Abstract methods

  protected abstract _hasRuntime(): boolean;
  protected abstract _closeRuntime(): Promise<void>;

  protected abstract _runtimeType(): string;

  // #endregion
}
