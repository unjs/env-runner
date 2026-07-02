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

export abstract class BaseEnvRunner implements EnvRunner, AsyncDisposable {
  closed: boolean = false;

  protected _name: string;
  protected _workerEntry: string;
  protected _data?: EnvRunnerData;
  protected _virtualSources?: VirtualModules;
  protected _hooks: Partial<WorkerHooks>;
  protected _address?: WorkerAddress;
  protected _messageListeners: Set<(data: unknown) => void>;
  protected _pendingRequests: Set<(cause?: unknown) => void>;
  protected _virtualResolved?: Promise<void>;

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
    this._pendingRequests = new Set();
  }

  get ready() {
    return Boolean(!this.closed && this._address && this._hasRuntime());
  }

  get address() {
    return this._address;
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
    return proxyFetch(this._address, this._resolveFetchInput(input), init);
  }

  async upgrade(context: { node: { req: IncomingMessage; socket: Socket; head: any } }) {
    // An upgrade can arrive while the worker is still (re)starting; wait for it
    // to become ready rather than silently dropping the connection.
    if (!this.ready) {
      await this.waitForReady().catch(() => {});
    }
    if (!this.ready || !this._address) {
      // The worker never came up (crash during init, timeout, closed). Nothing
      // downstream owns this raw socket, so destroy it instead of leaking the
      // fd and leaving the client hanging until its own timeout.
      context.node.socket.destroy();
      return;
    }
    try {
      await proxyUpgrade(this._address, context.node.req, context.node.socket, context.node.head);
    } catch {
      // The worker may refuse the upgrade (e.g. the `upgrade` hook returned a
      // non-101 response to reject the connection). `proxyUpgrade` has already
      // settled the client socket (forwarding the upstream response or
      // destroying it), so swallow the rejection to avoid an unhandled promise
      // rejection in fire-and-forget callers.
    }
  }

  abstract sendMessage(message: unknown): void;

  onMessage(listener: RunnerMessageListener) {
    this._messageListeners.add(listener);
  }

  offMessage(listener: RunnerMessageListener) {
    this._messageListeners.delete(listener);
  }

  waitForReady(timeout = 15_000): Promise<void> {
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
    return this._request<{ data: T }>(
      { __rpc: name, __rpc_id: id, data },
      {
        match: (msg) => msg?.__rpc_id === id,
        timeout: opts?.timeout ?? 3000,
        timeoutError: `RPC "${name}" timed out`,
      },
    ).then((msg) => msg.data);
  }

  async reloadModule(timeout = 5000): Promise<void> {
    await this._request(
      { event: "reload-module" },
      {
        match: (msg) => msg?.event === "module-reloaded",
        timeout,
        timeoutError: "Module reload timed out",
      },
    );
  }

  /**
   * Invalidate a virtual module so the next `reloadModule()` re-evaluates it.
   * A factory-valued `data.virtual` source is re-run on the host and the fresh
   * source is shipped to the worker along with the invalidation. Rejects when
   * the specifier is not a registered virtual module.
   */
  async invalidateModule(specifier: string, timeout = 5000): Promise<void> {
    const source = await this._refreshVirtualSource(specifier);
    await this._request(
      { event: "invalidate-module", specifier, source },
      {
        match: (msg) => msg?.event === "module-invalidated" && msg.specifier === specifier,
        timeout,
        timeoutError: `Module invalidation timed out for "${specifier}"`,
      },
    );
  }

  async close(cause?: unknown) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Safe to iterate directly: each rejector only deletes itself from the set.
    for (const rejectPending of this._pendingRequests) {
      rejectPending(cause);
    }
    this._pendingRequests.clear();
    this._hooks.onClose?.(this, cause);
    this._hooks = {};
    const onError = (error: unknown) => console.error(error);
    await this._closeRuntime().catch(onError);
    await this._closeSocket().catch(onError);
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    // eslint-disable-next-line unicorn/no-nested-ternary
    const status = this.closed ? "closed" : this.ready ? "ready" : "pending";
    return `${this.constructor.name}#${this._name}(${status})`;
  }

  // #endregion

  // #region Protected methods

  /**
   * Resolve a relative fetch input (e.g. `"/path"`) against a placeholder
   * `http://localhost` origin so it parses as a full URL. The origin is a
   * placeholder — requests are dispatched to the worker address regardless.
   */
  protected _resolveFetchInput(input: string | URL | Request): string | URL | Request {
    if (typeof input === "string" && !URL.canParse(input)) {
      return new URL(input, "http://localhost");
    }
    return input;
  }

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
   * Send a message and await a matching response message. Shared by `rpc()`,
   * `reloadModule()`, and `invalidateModule()`. Rejects on timeout, on a
   * response carrying an `error`, and promptly when the runner closes mid-wait
   * (instead of letting callers wait out the timeout on a dead worker).
   */
  protected _request<T = unknown>(
    message: unknown,
    opts: {
      match: (msg: any) => boolean;
      timeout: number;
      timeoutError: string;
      send?: (message: unknown) => void;
    },
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Runner is closed"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(opts.timeoutError));
      }, opts.timeout);
      const listener = (msg: any) => {
        if (opts.match(msg)) {
          cleanup();
          if (msg.error) {
            reject(typeof msg.error === "string" ? new Error(msg.error) : msg.error);
          } else {
            resolve(msg as T);
          }
        }
      };
      const onClose = (cause?: unknown) => {
        cleanup();
        reject(new Error("Runner closed before responding", cause ? { cause } : undefined));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.offMessage(listener);
        this._pendingRequests.delete(onClose);
      };
      this.onMessage(listener);
      this._pendingRequests.add(onClose);
      try {
        (opts.send ?? ((m: unknown) => this.sendMessage(m)))(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
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
    // Keep the original sources (including factories) so `invalidateModule()`
    // can re-run a factory for fresh contents.
    this._virtualSources = virtual;
    if (!virtual || !Object.values(virtual).some((v) => typeof v === "function")) {
      return undefined;
    }
    this._virtualResolved = resolveVirtualModules(virtual).then((resolved) => {
      this._data = { ...this._data, virtual: resolved };
    });
    return this._virtualResolved;
  }

  /**
   * Re-run a factory-valued virtual source on the host and sync the resolved
   * `data.virtual` map. Returns the fresh source, or `undefined` when the
   * source is a plain string or unknown (nothing to re-evaluate).
   */
  protected async _refreshVirtualSource(specifier: string): Promise<string | undefined> {
    // Wait for the initial factory resolution first: until it settles,
    // `_data.virtual` still aliases the original (factory-valued) map, and
    // writing a resolved string into it would permanently replace the factory.
    // (A rejected resolution closes the runner via `_initWithVirtualData`.)
    await this._virtualResolved?.catch(() => {});
    const original = this._virtualSources?.[specifier];
    if (typeof original !== "function") {
      return undefined;
    }
    const source = await original();
    const resolved = this._data?.virtual as Record<string, string> | undefined;
    if (resolved) {
      resolved[specifier] = source;
    }
    return source;
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
