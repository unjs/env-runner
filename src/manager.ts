import type { ServerPlugin } from "srvx";
import type {
  EnvRunner,
  RunnerMessageListener,
  FetchHandler,
  UpgradeHandler,
  WorkerAddress,
} from "./types.ts";

import { createRunnerWSProxyPlugin } from "./common/ws-proxy.ts";

/**
 * Manages an active `EnvRunner` instance, proxying all calls to it.
 * Supports hot-reload, auto-restart on unexpected exit, and message queueing.
 */
export class RunnerManager implements EnvRunner, AsyncDisposable {
  private _runner: EnvRunner | undefined;
  private _messageQueue: unknown[] = [];
  private _messageListeners = new Set<RunnerMessageListener>();
  private _closed = false;
  private _reloading = false;
  private _moduleInvalidated = false;
  private _pendingModuleReload: Promise<void> | undefined;
  private _closeListeners = new Set<(runner: EnvRunner, cause?: unknown) => void>();
  private _readyListeners = new Set<(runner: EnvRunner, address?: WorkerAddress) => void>();
  private _readyRejectors = new Set<() => void>();

  constructor(runner?: EnvRunner) {
    if (runner) {
      this._attach(runner);
    }
  }

  get ready() {
    return this._runner?.ready ?? false;
  }

  get closed() {
    return this._closed;
  }

  get address() {
    return this._runner?.address;
  }

  /**
   * Replace the active runner with a new one. Closes the previous runner.
   *
   * When called without a runner, a fresh one is created via `_createRunner()`
   * (only available on subclasses with a runner factory, e.g. `EnvServer`).
   */
  async reload(runner?: EnvRunner) {
    this._reloading = true;
    try {
      runner ??= await this._createRunner();
      const prev = this._runner;
      this._detach();
      this._attach(runner);
      // A fresh runner re-resolves its sources, satisfying any pending invalidation.
      this._moduleInvalidated = false;
      if (prev) {
        await prev.close();
      }
    } finally {
      this._reloading = false;
    }
  }

  /** Create a fresh runner for argument-less `reload()`. Overridden by subclasses with a runner factory. */
  protected _createRunner(): EnvRunner | Promise<EnvRunner> {
    throw new Error("reload() requires a runner argument (this manager has no runner factory)");
  }

  // #region EnvRunner proxy

  fetch: FetchHandler = (input, init) => this._fetch(input, init);

  protected async _fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const runner = await this._waitForRunner();
    if (!runner) {
      return new Response("Runner is unavailable", { status: 503 });
    }
    if (this._moduleInvalidated) {
      await this._flushInvalidation(runner);
    }
    return runner.fetch(input, init);
  }

  /**
   * Lazily satisfy a pending `invalidateModule()` with a single entry reload
   * before serving — concurrent fetches share the same reload. A failed reload
   * keeps the invalidation pending, so the next fetch retries.
   */
  private _flushInvalidation(runner: EnvRunner): Promise<void> {
    this._pendingModuleReload ??= Promise.resolve(runner.reloadModule?.())
      .then(() => {
        this._moduleInvalidated = false;
      })
      .finally(() => {
        this._pendingModuleReload = undefined;
      });
    return this._pendingModuleReload;
  }

  upgrade: UpgradeHandler = (context) => {
    this._runner?.upgrade?.(context);
  };

  /**
   * Create a runtime-native WebSocket reverse-proxy plugin for the public srvx
   * server. Attach it via `serve({ plugins: [await manager.wsSrvxPlugin()] })`:
   * on Node it proxies the raw upgrade socket to the worker, and on Bun/Deno it
   * bridges the WebSocket with crossws. The plugin reads the active runner
   * lazily, so it keeps working across hot-reloads.
   */
  wsSrvxPlugin(): Promise<ServerPlugin> {
    return createRunnerWSProxyPlugin(() => this);
  }

  sendMessage(message: unknown) {
    if (!this._runner || !this._runner.ready) {
      this._messageQueue.push(message);
      return;
    }
    this._runner.sendMessage(message);
  }

  onMessage(listener: RunnerMessageListener) {
    this._messageListeners.add(listener);
    this._runner?.onMessage(listener);
  }

  offMessage(listener: RunnerMessageListener) {
    this._messageListeners.delete(listener);
    this._runner?.offMessage(listener);
  }

  waitForReady(timeout = 5000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this._closed) return Promise.reject(new Error("Runner closed before becoming ready"));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.offMessage(listener);
        this._readyRejectors.delete(onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Runner did not become ready in time"));
      }, timeout);
      const listener = (message: any) => {
        if (message?.address || this.ready) {
          cleanup();
          resolve();
        }
      };
      // Reject promptly if the manager is closed mid-wait instead of letting the
      // caller wait out the full timeout on a manager that will never be ready.
      const onClose = () => {
        cleanup();
        reject(new Error("Runner closed before becoming ready"));
      };
      // Register via `onMessage` so the listener is forwarded to the active
      // runner (and re-forwarded to a fresh one across reloads); a direct
      // `_messageListeners` add would never receive the worker's ready message.
      this.onMessage(listener);
      this._readyRejectors.add(onClose);
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

  async reloadModule(timeout?: number): Promise<void> {
    if (!this._runner?.reloadModule) {
      throw new Error("Active runner does not support reloadModule()");
    }
    await this._runner.reloadModule(timeout);
    // An explicit reload satisfies any pending invalidation.
    this._moduleInvalidated = false;
  }

  /**
   * Invalidate a virtual module on the active runner and mark the manager
   * dirty: the next `fetch()` reloads the entry automatically, so callers
   * don't need to pair the call with an explicit `reloadModule()`.
   */
  async invalidateModule(specifier: string, timeout?: number): Promise<void> {
    if (!this._runner?.invalidateModule) {
      throw new Error("Active runner does not support invalidateModule()");
    }
    await this._runner.invalidateModule(specifier, timeout);
    this._moduleInvalidated = true;
  }

  async close() {
    this._closed = true;
    this._messageQueue.length = 0;
    // Fail any in-flight `waitForReady()` callers promptly.
    for (const rejectReady of this._readyRejectors) rejectReady();
    this._readyRejectors.clear();
    const runner = this._runner;
    this._detach();
    if (runner) {
      await runner.close();
    }
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  // #endregion

  // #region Hooks (forwarded to active runner)

  onClose(listener: (runner: EnvRunner, cause?: unknown) => void) {
    this._closeListeners.add(listener);
  }

  offClose(listener: (runner: EnvRunner, cause?: unknown) => void) {
    this._closeListeners.delete(listener);
  }

  onReady(listener: (runner: EnvRunner, address?: WorkerAddress) => void) {
    this._readyListeners.add(listener);
  }

  offReady(listener: (runner: EnvRunner, address?: WorkerAddress) => void) {
    this._readyListeners.delete(listener);
  }

  // #endregion

  // #region Private

  private _internalListener: RunnerMessageListener = (message: any) => {
    // Detect ready state from address message
    if (message?.address) {
      this._flushQueue();
      for (const fn of this._readyListeners) fn(this, message.address);
    }
  };

  private _attach(runner: EnvRunner) {
    this._runner = runner;

    // Listen for address/ready messages internally
    runner.onMessage(this._internalListener);

    // Forward existing message listeners
    for (const listener of this._messageListeners) {
      runner.onMessage(listener);
    }

    // Wrap close() to detect when runner exits (works with BaseEnvRunner)
    const originalClose = runner.close.bind(runner);
    runner.close = async () => {
      await originalClose();
      if (this._runner === runner) {
        this._runner = undefined;
        for (const fn of this._closeListeners) fn(this);
      }
    };

    // If already ready, flush immediately
    if (runner.ready) {
      this._flushQueue();
    }
  }

  private _detach() {
    const runner = this._runner;
    if (!runner) return;
    this._runner = undefined;
    runner.offMessage(this._internalListener);
    for (const listener of this._messageListeners) {
      runner.offMessage(listener);
    }
  }

  private _waitForRunner(timeout = 3000): Promise<EnvRunner | undefined> {
    if (this._runner) {
      return Promise.resolve(this._runner);
    }
    if (!this._reloading) {
      return Promise.resolve(undefined);
    }
    return new Promise<EnvRunner | undefined>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this._runner) {
          return resolve(this._runner);
        }
        if (this._closed || Date.now() - start >= timeout) {
          return resolve(undefined);
        }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  }

  private _flushQueue() {
    if (!this._runner || this._messageQueue.length === 0) {
      return;
    }
    const queue = [...this._messageQueue];
    this._messageQueue.length = 0;
    for (const msg of queue) {
      this._runner.sendMessage(msg);
    }
  }

  // #endregion
}
