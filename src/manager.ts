import type {
  EnvRunner,
  RunnerMessageListener,
  FetchHandler,
  UpgradeHandler,
  WorkerAddress,
} from "./types.ts";

/**
 * Manages an active `EnvRunner` instance, proxying all calls to it.
 * Supports hot-reload, auto-restart on unexpected exit, and message queueing.
 */
export class RunnerManager implements EnvRunner {
  private _runner: EnvRunner | undefined;
  private _messageQueue: unknown[] = [];
  private _messageListeners = new Set<RunnerMessageListener>();
  private _closed = false;
  private _reloading = false;

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

  /** Replace the active runner with a new one. Closes the previous runner. */
  async reload(runner: EnvRunner) {
    this._reloading = true;
    const prev = this._runner;
    this._detach();
    this._attach(runner);
    this._reloading = false;
    if (prev) {
      await prev.close();
    }
  }

  // #region EnvRunner proxy

  fetch: FetchHandler = async (input, init) => {
    const runner = await this._waitForRunner();
    if (!runner) {
      return new Response("Runner is unavailable", { status: 503 });
    }
    return runner.fetch(input, init);
  };

  upgrade: UpgradeHandler = (context) => {
    this._runner?.upgrade?.(context);
  };

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

  async close() {
    this._closed = true;
    this._messageQueue.length = 0;
    const runner = this._runner;
    this._detach();
    if (runner) {
      await runner.close();
    }
  }

  // #endregion

  // #region Hooks (forwarded to active runner)

  onClose?: (runner: EnvRunner, cause?: unknown) => void;
  onReady?: (runner: EnvRunner, address?: WorkerAddress) => void;

  // #endregion

  // #region Private

  private _internalListener: RunnerMessageListener = (message: any) => {
    // Detect ready state from address message
    if (message?.address) {
      this._flushQueue();
      this.onReady?.(this, message.address);
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
        this.onClose?.(this);
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
