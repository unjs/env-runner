import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RunnerMessageListener, EnvRunner, WorkerAddress, WorkerHooks } from "../types.ts";

import { rm } from "node:fs/promises";
import { proxyFetch, proxyUpgrade } from "httpxy";
import {
  encodeVirtualModules,
  normalizeVirtualModules,
  resolveVirtualModules,
  warnVirtualPathCollisions,
} from "../virtual-loader.ts";
import type {
  ResolvedVirtualModule,
  VirtualModuleContent,
  VirtualModules,
  VirtualModuleSource,
  VirtualModuleUpdates,
} from "../virtual-loader.ts";
import { hostEnv } from "./host-env.ts";

export type {
  VirtualModule,
  VirtualModuleContent,
  VirtualModuleFormat,
  VirtualModules,
  VirtualModuleSource,
  VirtualModuleUpdates,
} from "../virtual-loader.ts";

export interface EnvRunnerData {
  name?: string;

  /**
   * Virtual modules importable from the entry, e.g.
   * `{ "#virtual-import": "export const foo = 1" }`. A source is a string, a
   * `Uint8Array` or `{ source, format }` (format by extension by default), or
   * a factory returning one, which runs on the host before spawn. Change them
   * at runtime with `updateVirtualModules()`. Not supported by the `self`
   * runner (it closes with an error).
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
  // Rejectors run by `close()`: in-flight `_request()` and `waitForReady()` calls.
  protected _pendingRequests: Set<(cause?: unknown) => void>;
  protected _closeCause?: unknown;
  protected _virtualResolved?: Promise<void>;
  // Tail of the virtual module update queue (never rejects).
  protected _virtualUpdates: Promise<void> = Promise.resolve();
  #virtualUpdateId = 0;
  // Runner data JSON for process workers, snapshotted at spawn (`_processEnv()`).
  protected _processData?: string;

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
    await this._waitForAddress();
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
      // Worker never came up: nothing else owns the socket, destroy to avoid a leak.
      context.node.socket.destroy();
      return;
    }
    try {
      await proxyUpgrade(this._address, context.node.req, context.node.socket, context.node.head);
    } catch {
      // The worker may reject the upgrade; `proxyUpgrade` already settled the
      // client socket, so swallow (callers are fire-and-forget).
    }
  }

  abstract sendMessage(message: unknown): void;

  onMessage(listener: RunnerMessageListener) {
    this._messageListeners.add(listener);
  }

  offMessage(listener: RunnerMessageListener) {
    this._messageListeners.delete(listener);
  }

  /** Rejects on timeout, and as soon as the runner closes (with the close cause). */
  waitForReady(timeout = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) return Promise.reject(closedBeforeReadyError(this._closeCause));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Runner did not become ready in time"));
      }, timeout);
      const listener = () => {
        if (this.ready) {
          cleanup();
          resolve();
        }
      };
      // Via `close()`, not a message: a runner can close without the worker
      // sending anything (exit, spawn error, failed `self` entry import).
      const onClose = (cause?: unknown) => {
        cleanup();
        reject(closedBeforeReadyError(cause));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this._messageListeners.delete(listener);
        this._pendingRequests.delete(onClose);
      };
      this._messageListeners.add(listener);
      this._pendingRequests.add(onClose);
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

  /** Re-import the entry, after any pending `updateVirtualModules()` call. */
  async reloadModule(timeout = 5000): Promise<void> {
    await this._virtualUpdates;
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
   * Set (add or replace) and remove (`null`) virtual modules in one round trip.
   * Factory sources run on the host. Changed and removed keys, and the modules
   * importing them, evaluate fresh on the next `reloadModule()`; a removed key
   * falls through to normal resolution. Calls apply in order, waiting for the
   * runner to become ready. The runner keeps its own copy of the map in sync,
   * never changing the caller's `data.virtual`.
   */
  updateVirtualModules(changes: VirtualModuleUpdates, timeout = 5000): Promise<void> {
    return this._enqueueVirtualUpdate(() => changes, timeout);
  }

  /**
   * Invalidate a virtual module so the next `reloadModule()` re-evaluates it:
   * `updateVirtualModules()` with its current source, so a factory re-runs.
   * Rejects for unknown specifiers.
   */
  invalidateModule(specifier: string, timeout = 5000): Promise<void> {
    return this._enqueueVirtualUpdate(() => {
      const source = this._virtualSources?.[specifier];
      if (source === undefined) {
        throw new Error(`Cannot invalidate "${specifier}" (not a registered virtual module)`);
      }
      return { [specifier]: source };
    }, timeout);
  }

  async close(cause?: unknown) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._closeCause = cause;
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

  /** Briefly back off (~3s total) while the worker is still starting. */
  protected async _waitForAddress() {
    for (let i = 0; i < 5 && !this._address && !this.closed; i++) {
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i)));
    }
  }

  /** Placeholder origin for relative inputs; requests go to the worker address regardless. */
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
    // `init-error` gives the close a meaningful cause instead of a bare exit code.
    if (message?.event === "init-error" && !this.ready && !this.closed) {
      this.close(new Error(String(message.error || "Worker initialization failed")));
    }
    for (const listener of this._messageListeners) {
      listener(message);
    }
  }

  /**
   * Env for a process worker. Also snapshots the runner data, which goes over
   * IPC on request (see `common/process-data.ts`), virtual module bytes as
   * base64; throws if not JSON-serializable.
   */
  protected _processEnv(): NodeJS.ProcessEnv {
    const data = this._data || {};
    const virtual = data.virtual as Record<string, ResolvedVirtualModule> | undefined;
    try {
      this._processData = JSON.stringify(
        virtual ? { ...data, virtual: encodeVirtualModules(virtual) } : data,
      );
    } catch (error: any) {
      throw new TypeError(`Runner data must be JSON-serializable: ${error?.message || error}`, {
        cause: error,
      });
    }
    return hostEnv({ ENV_RUNNER_NAME: this._name });
  }

  /**
   * Process worker messages: answer the `request-init-data` handshake with the
   * runner data (internal, not forwarded to listeners), handle everything else.
   */
  protected _handleProcessMessage(message: any) {
    if (message?.event !== "request-init-data") {
      this._handleMessage(message);
      return;
    }
    if (this.closed) {
      return;
    }
    try {
      this.sendMessage({ event: "init-data", data: this._processData ?? "{}" });
    } catch (error: any) {
      const cause = new Error(
        `Failed to send runner data to the worker over IPC: ${error?.message || error}`,
        { cause: error },
      );
      console.error(`[env-runner] ${cause.message}`);
      this.close(cause);
    }
  }

  /**
   * Send a message and await the matching response. Rejects on timeout, on an
   * `error` response, and as soon as the runner closes.
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
   * Resolve factory `data.virtual` sources before spawn (functions can't cross
   * the worker boundary; the load hook can't await), and validate every
   * module. `undefined` when there is no factory and nothing is invalid, so
   * subclasses can spawn synchronously.
   */
  protected _resolveVirtualData(): Promise<void> | undefined {
    const virtual = this._data?.virtual;
    // Own copies, since updates change them in place (never the caller's
    // options). The original sources, factories included, let
    // `invalidateModule()` re-run a factory.
    this._virtualSources = { ...virtual };
    this._data = { ...this._data };
    warnVirtualPathCollisions(Object.keys(virtual ?? {}));
    if (!virtual) {
      return undefined;
    }
    if (!Object.values(virtual).some((v) => typeof v === "function")) {
      try {
        this._data.virtual = normalizeVirtualModules(
          virtual as Record<string, VirtualModuleContent>,
        );
        return undefined;
      } catch (error) {
        // Like a throwing factory: the runner closes with it as cause.
        this._virtualResolved = Promise.reject(error);
        return this._virtualResolved;
      }
    }
    this._virtualResolved = resolveVirtualModules(virtual).then((resolved) => {
      this._data = { ...this._data, virtual: resolved };
    });
    return this._virtualResolved;
  }

  /**
   * Queue a virtual module update. Updates apply one at a time in call order
   * (`changes` is read when its turn comes), each after the initial factory
   * resolution: until it settles, `_data.virtual` aliases the factory map.
   */
  protected _enqueueVirtualUpdate(
    changes: () => VirtualModuleUpdates,
    timeout: number,
  ): Promise<void> {
    const update = this._virtualUpdates.then(async () => {
      // A failed initial resolution closes the runner (and leaves the alias).
      await this._virtualResolved;
      if (this.closed) {
        throw new Error("Runner is closed");
      }
      const entries = Object.entries(changes()).filter(([, source]) => source !== undefined);
      if (entries.length === 0) {
        return;
      }
      // Factories run on the host; one that throws, or an invalid module,
      // rejects before any change.
      const sets: VirtualModules = Object.fromEntries(
        entries.filter((entry): entry is [string, VirtualModuleSource] => entry[1] !== null),
      );
      const resolved: Record<string, ResolvedVirtualModule | null> =
        await resolveVirtualModules(sets);
      const sources = (this._virtualSources ??= {});
      const virtual = ((this._data ??= {}).virtual ??= {}) as Record<string, ResolvedVirtualModule>;
      let added = false;
      for (const [key, source] of entries) {
        if (source === null) {
          resolved[key] = null;
          delete sources[key];
          delete virtual[key];
        } else {
          added ||= !Object.hasOwn(sources, key);
          sources[key] = source;
          virtual[key] = resolved[key]!;
        }
      }
      if (added) {
        warnVirtualPathCollisions(Object.keys(virtual));
      }
      if (!this.ready) {
        await this.waitForReady();
      }
      await this._applyVirtualUpdates(resolved, timeout);
    });
    this._virtualUpdates = update.catch(() => {});
    return update;
  }

  /**
   * Apply resolved changes (`null` removes) to the running worker in one round
   * trip, bytes as base64 (the message may be JSON). Overridden by runners
   * serving virtual modules from the host.
   */
  protected async _applyVirtualUpdates(
    changes: Record<string, ResolvedVirtualModule | null>,
    timeout: number,
  ): Promise<void> {
    const id = ++this.#virtualUpdateId;
    await this._request(
      { event: "update-virtual-modules", id, changes: encodeVirtualModules(changes) },
      {
        match: (msg) => msg?.event === "virtual-modules-updated" && msg.id === id,
        timeout,
        timeoutError: "Virtual module update timed out",
      },
    );
  }

  /**
   * Run `init` once `data.virtual` is resolved (synchronously without factories).
   * A failing factory (or deferred `init`, e.g. a spawn error) closes the runner
   * with the error as cause.
   */
  protected _initWithVirtualData(init: () => void): void {
    const pending = this._resolveVirtualData();
    if (pending) {
      pending
        .then(() => {
          if (!this.closed) init();
        })
        .catch((error) => this.close(error));
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

function closedBeforeReadyError(cause: unknown): Error {
  return new Error("Runner closed before becoming ready", cause ? { cause } : undefined);
}
