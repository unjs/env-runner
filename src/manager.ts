import type { ServerPlugin } from "srvx";
import { FastResponse } from "srvx";
import type {
  EnvRunner,
  RunnerMessageListener,
  FetchHandler,
  UpgradeHandler,
  WorkerAddress,
} from "./types.ts";
import type { VirtualModuleUpdates } from "./virtual-loader.ts";

import { createRunnerWSProxyPlugin } from "./common/ws-proxy.ts";

/** Default `drain` timeout of `RunnerManager.reload()`. */
const DRAIN_TIMEOUT = 60_000;

/** Options for `RunnerManager.reload()`. */
export interface RunnerReloadOptions {
  /**
   * Keep the previous runner serving the requests and WebSockets it already
   * accepted, and shut it down (`shutdown()`, else `close()`) once they settle.
   * After `timeout` ms (default `60_000`, also for `NaN`; `Infinity` for no
   * limit), it is closed with whatever is still open. New requests and upgrades go to the
   * new runner right away. Without it, the previous runner is closed
   * immediately.
   */
  drain?: boolean | { timeout?: number };
}

/** Proxies an active `EnvRunner` with hot-reload, auto-restart and message queueing. */
export class RunnerManager implements EnvRunner, AsyncDisposable {
  private _runner: EnvRunner | undefined;
  // The runner `close()`/`shutdown()` is closing (no longer `_runner`).
  private _closingRunner: EnvRunner | undefined;
  private _messageQueue: unknown[] = [];
  private _messageListeners = new Set<RunnerMessageListener>();
  private _closed = false;
  private _reloading = false;
  private _moduleInvalidated = false;
  // The shared `reloadModule()` of `_flushInvalidation()`, for its runner.
  private _pendingModuleReload: { runner: EnvRunner; promise: Promise<void> } | undefined;
  private _closeListeners = new Set<(runner: EnvRunner, cause?: unknown) => void>();
  private _readyListeners = new Set<(runner: EnvRunner, address?: WorkerAddress) => void>();
  private _readyRejectors = new Set<() => void>();
  // Requests (until their body settles) and WebSockets each runner serves.
  private _exchanges = new WeakMap<EnvRunner, number>();
  // Previous runners draining after `reload()` (until closed or attached again).
  private _draining = new Map<EnvRunner, DrainingRunner>();
  // Runners whose `close()` `_attach()` wrapped (once, even when attached again).
  private _wrappedRunners = new WeakSet<EnvRunner>();

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
   * Replace (and close) the active runner. Without an argument, subclasses with
   * `_createRunner()` (e.g. `EnvServer`) create a fresh one. With `drain`, the
   * previous runner retires in the background once its requests and
   * WebSockets settle (see {@link RunnerReloadOptions}).
   */
  async reload(runner?: EnvRunner, opts?: RunnerReloadOptions) {
    this._reloading = true;
    try {
      runner ??= await this._createRunner();
      // Closed meanwhile (e.g. during a slow `_createRunner()`): don't revive it.
      if (this._closed) {
        await runner.close();
        return;
      }
      const prev = this._runner;
      // Attached again while draining (e.g. swapping back): it serves again.
      this._draining.get(runner)?.cancel();
      if (prev === runner) {
        return;
      }
      this._detach();
      this._attach(runner);
      // A fresh runner re-resolves its sources, satisfying any pending invalidation.
      this._moduleInvalidated = false;
      if (prev && opts?.drain) {
        this._drain(prev, (opts.drain === true ? undefined : opts.drain.timeout) ?? DRAIN_TIMEOUT);
      } else if (prev) {
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
    // Read and count the runner in the same tick, so a drained `reload()` in
    // between can't retire it as idle.
    if (!this._runner) {
      await this._waitForRunner();
    }
    const runner = this._runner;
    if (!runner) {
      return new Response("Runner is unavailable", { status: 503 });
    }
    const settle = this._beginExchange(runner);
    try {
      if (this._moduleInvalidated) {
        await this._flushInvalidation(runner);
      }
      return trackResponseBody(await runner.fetch(input, init), settle);
    } catch (error) {
      settle();
      throw error;
    }
  }

  /**
   * Apply a pending invalidation with one shared reload per runner; a failure
   * retries on the next fetch. A reload of a runner replaced meanwhile (still
   * draining) leaves the invalidation of the new one pending.
   */
  private _flushInvalidation(runner: EnvRunner): Promise<void> {
    if (this._pendingModuleReload?.runner === runner) {
      return this._pendingModuleReload.promise;
    }
    const pending = {
      runner,
      promise: Promise.resolve(runner.reloadModule?.())
        .then(() => {
          if (this._runner === runner) this._moduleInvalidated = false;
        })
        .finally(() => {
          if (this._pendingModuleReload === pending) this._pendingModuleReload = undefined;
        }),
    };
    this._pendingModuleReload = pending;
    return pending.promise;
  }

  upgrade: UpgradeHandler = async (context) => {
    // Read and count the runner in the same tick (see `_fetch()`).
    if (!this._runner) {
      await this._waitForRunner();
    }
    const runner = this._runner;
    if (!runner?.upgrade) {
      // No runner owns the socket (crash/reload gap): destroy to avoid a leak.
      context.node.socket.destroy();
      return;
    }
    const { socket } = context.node;
    if (!socket.destroyed) {
      socket.once("close", this._beginExchange(runner));
    }
    await runner.upgrade(context);
  };

  /** WebSocket proxy plugin: `serve({ plugins: [await manager.wsSrvxPlugin()] })`. */
  wsSrvxPlugin(): Promise<ServerPlugin> {
    return createRunnerWSProxyPlugin(
      () => this,
      (address) => {
        const runner = this._runner;
        // The target resolved asynchronously (mid-reload) and the runner changed
        // before crossws dialed: it may be retiring as idle already.
        if (!runner || runner.address !== address) {
          throw new Error("The runner changed before the WebSocket connected");
        }
        return this._beginExchange(runner);
      },
    );
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

  waitForReady(timeout = 15_000): Promise<void> {
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
      // Via `onMessage` so the listener follows the active runner across reloads.
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
    const runner = this._runner;
    if (!runner?.reloadModule) {
      throw new Error("Active runner does not support reloadModule()");
    }
    await runner.reloadModule(timeout);
    // An explicit reload satisfies any pending invalidation (of the same runner).
    if (this._runner === runner) this._moduleInvalidated = false;
  }

  /**
   * Set or remove (`null`) virtual modules of the active runner (waiting for it
   * during a reload); the next `fetch()` reloads the entry automatically.
   */
  async updateVirtualModules(changes: VirtualModuleUpdates, timeout?: number): Promise<void> {
    const runner = await this._waitForRunner();
    if (!runner?.updateVirtualModules) {
      throw new Error("Active runner does not support updateVirtualModules()");
    }
    await runner.updateVirtualModules(changes, timeout);
    this._moduleInvalidated = true;
  }

  /** Invalidate a virtual module; the next `fetch()` reloads the entry automatically. */
  async invalidateModule(specifier: string, timeout?: number): Promise<void> {
    const runner = await this._waitForRunner();
    if (!runner?.invalidateModule) {
      throw new Error("Active runner does not support invalidateModule()");
    }
    await runner.invalidateModule(specifier, timeout);
    this._moduleInvalidated = true;
  }

  /**
   * Close, shutting the active runner (and draining ones) down gracefully
   * (their `shutdown()`, else `close()`).
   */
  async shutdown(timeout?: number) {
    await this._close((runner) => (runner.shutdown ? runner.shutdown(timeout) : runner.close()));
  }

  async close() {
    await this._close(closeRunnerNow);
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

  private async _close(closeRunner: (runner: EnvRunner) => Promise<void>) {
    this._closed = true;
    this._messageQueue.length = 0;
    // Fail any in-flight `waitForReady()` callers promptly.
    for (const rejectReady of this._readyRejectors) rejectReady();
    this._readyRejectors.clear();
    const draining = Promise.all(
      [...this._draining.values()].map((draining) => draining.retire(closeRunner)),
    );
    // A `close()` during a `shutdown()` closes the same runner.
    const runner = this._runner ?? this._closingRunner;
    if (!runner) {
      await draining;
      return;
    }
    // No longer active, so its close isn't reported to `onClose()` listeners;
    // message listeners stay until it closed (messages from `ipc.onClose`).
    this._runner = undefined;
    this._closingRunner = runner;
    try {
      await Promise.all([closeRunner(runner), draining]);
    } finally {
      if (this._closingRunner === runner) {
        this._closingRunner = undefined;
      }
      this._detachListeners(runner);
    }
  }

  /** Count a request or WebSocket served by `runner` until the returned function is called. */
  private _beginExchange(runner: EnvRunner): () => void {
    this._exchanges.set(runner, (this._exchanges.get(runner) ?? 0) + 1);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const count = this._exchanges.get(runner)! - 1;
      if (count > 0) {
        this._exchanges.set(runner, count);
        return;
      }
      this._exchanges.delete(runner);
      void this._draining.get(runner)?.retire();
    };
  }

  /**
   * Retire a detached runner: shut it down once its exchanges settle, or close
   * it after `timeout`. `_close()` retires it early with its own close
   * function, a runner that closes itself meanwhile (crash) just stops
   * draining, and `reload()` cancels it for a runner attached again.
   */
  private _drain(runner: EnvRunner, timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retiring: Promise<void> | undefined;
    const draining: DrainingRunner = {
      retire: (close = shutdownRunner) => {
        clearTimeout(timer);
        // Once shutting down, only an immediate `close()` goes ahead.
        if (!retiring || (close === closeRunnerNow && !runner.closed)) {
          // Also catches a close function that throws synchronously.
          retiring = new Promise<void>((resolve) => resolve(close(runner)))
            .catch((error) => {
              console.error("[env-runner] Failed to close the drained runner:", error);
            })
            .finally(() => {
              if (this._draining.get(runner) === draining) this._draining.delete(runner);
            });
        }
        return retiring;
      },
      cancel: () => {
        clearTimeout(timer);
        // Already shutting down: it closes once attached (reported to `onClose()`).
        if (!retiring) this._draining.delete(runner);
      },
    };
    this._draining.set(runner, draining);
    // `NaN` (e.g. from an unset env var) is the default, negative values are 0.
    timeout = Number.isNaN(timeout) ? DRAIN_TIMEOUT : Math.max(timeout, 0);
    if (!this._exchanges.has(runner) || runner.closed) {
      void draining.retire();
    } else if (timeout < 2 ** 31) {
      // Beyond `setTimeout()`'s limit (`Infinity` included): no limit.
      timer = setTimeout(() => draining.retire(closeRunnerNow), timeout);
    }
  }

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

    // Wrap close() to detect when runner exits (works with BaseEnvRunner). Runners
    // close themselves via this wrapper, so forward the cause (`hooks.onClose`,
    // `waitForReady()` rejections). Once per runner: a second wrapper would
    // report its close twice.
    if (!this._wrappedRunners.has(runner)) {
      this._wrappedRunners.add(runner);
      const originalClose = runner.close.bind(runner) as (cause?: unknown) => Promise<void>;
      runner.close = async (cause?: unknown) => {
        await originalClose(cause);
        // Draining and closed by itself (or its `shutdown()`): nothing left to retire.
        void this._draining.get(runner)?.retire(async () => {});
        if (this._runner === runner) {
          this._runner = undefined;
          for (const fn of this._closeListeners) fn(this, cause);
        }
      };
    }

    // If already ready, flush immediately
    if (runner.ready) {
      this._flushQueue();
    }
  }

  private _detach() {
    const runner = this._runner;
    if (!runner) return;
    this._runner = undefined;
    this._detachListeners(runner);
  }

  private _detachListeners(runner: EnvRunner) {
    runner.offMessage(this._internalListener);
    for (const listener of this._messageListeners) {
      runner.offMessage(listener);
    }
  }

  /** The active runner, waiting for one during a reload. */
  protected _waitForRunner(timeout = 3000): Promise<EnvRunner | undefined> {
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

/** A runner draining after `reload()`. */
interface DrainingRunner {
  /** Close it (`shutdown()` by default); once shutting down, only `close()` goes ahead. */
  retire(close?: (runner: EnvRunner) => Promise<void>): Promise<void>;
  /** Stop draining (unless already shutting down), for a runner attached again. */
  cancel(): void;
}

function closeRunnerNow(runner: EnvRunner): Promise<void> {
  return runner.close();
}

function shutdownRunner(runner: EnvRunner): Promise<void> {
  return runner.shutdown ? runner.shutdown() : runner.close();
}

/** srvx's `FastResponse` on Node, as its Node adapter reads it (internal API). */
interface NodeFastResponse extends Response {
  _toNodeResponse(): { status: number; statusText: string; headers: unknown[]; body?: unknown };
}

/**
 * `settle` once the response body is read to the end, fails or is canceled.
 * A `FastResponse` builds the native `Response` lazily, and srvx's Node
 * adapter sends it without one.
 */
function trackResponseBody(response: Response, settle: () => void): Response {
  if (typeof (response as Partial<NodeFastResponse> | undefined)?._toNodeResponse === "function") {
    return trackNodeFastResponse(response as NodeFastResponse, settle);
  }
  if (!response?.body) {
    settle();
    return response;
  }
  return new FastResponse(trackStream(response.body, settle), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A runner's srvx `FastResponse` on Node (e.g. from the `self` runner): read
 * like srvx's Node adapter does, since `.body` would turn it into a native
 * `Response` and lose the `content-type`/`content-length` srvx derives from a
 * string or byte body. Such a buffered body settles right away.
 */
function trackNodeFastResponse(response: NodeFastResponse, settle: () => void): Response {
  const { status, statusText, headers: rawHeaders, body } = response._toNodeResponse();
  const headers: [string, string][] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    headers.push([String(rawHeaders[i]), String(rawHeaders[i + 1])]);
  }
  let trackedBody = body;
  if (body instanceof ReadableStream) {
    trackedBody = trackStream(body, settle);
  } else if (typeof (body as NodeJS.ReadableStream | undefined)?.once === "function") {
    // A Node.js stream: until it is closed (ended, errored or destroyed).
    const stream = body as NodeJS.ReadableStream & { closed?: boolean };
    if (stream.closed) settle();
    else stream.once("close", settle);
  } else {
    settle();
  }
  return new FastResponse(trackedBody as BodyInit | null | undefined, {
    status,
    statusText,
    headers,
  });
}

function trackStream(stream: ReadableStream<Uint8Array>, settle: () => void) {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });
}
