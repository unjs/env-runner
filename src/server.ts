import { type FSWatcher, watch as watchFile } from "node:fs";
import type { EnvRunner, WorkerHooks } from "./types.ts";
import type { RunnerName } from "./loader.ts";
import type { VirtualModules, VirtualModuleUpdates } from "./virtual-loader.ts";

import { loadRunner } from "./loader.ts";
import { RunnerManager } from "./manager.ts";

export interface EnvServerOptions {
  /** Runner implementation to use (defaults to `"node-worker"`). */
  runner?: RunnerName;
  /** Path to the user entry module (passed as `data.entry`). */
  entry: string;
  /** Runner instance name. */
  name?: string;
  /** Lifecycle hooks. */
  hooks?: WorkerHooks;
  /** Additional data passed to the runner. */
  data?: Record<string, unknown>;
  /** Custom exec arguments (e.g. `--inspect`). */
  execArgv?: string[];
  /** Enable watch mode to auto-reload on entry file changes. */
  watch?: boolean;
  /** Additional paths to watch (directories or files). */
  watchPaths?: string[];
  /** Runner-specific constructor options (e.g. `{ miniflare }`). */
  runnerOptions?: Record<string, unknown>;
}

export class EnvServer extends RunnerManager {
  private _opts: EnvServerOptions;
  private _watchers: FSWatcher[] = [];
  private _reloadTimeout: ReturnType<typeof setTimeout> | undefined;
  private _reloadListeners = new Set<() => void>();
  private _startPromise: Promise<this> | undefined;
  // `data.virtual` with updates applied (own copy, once updated).
  private _virtual: VirtualModules | undefined;

  runner: Awaited<ReturnType<typeof loadRunner>> | null = null;

  /** Register a listener called when the runner is reloaded due to a file change. */
  onReload(listener: () => void) {
    this._reloadListeners.add(listener);
  }

  /** Remove a previously registered reload listener. */
  offReload(listener: () => void) {
    this._reloadListeners.delete(listener);
  }

  constructor(opts: EnvServerOptions) {
    super();
    this._opts = opts;
  }

  /**
   * Load and attach the runner. Idempotent and optional (the first `fetch()`
   * auto-starts); a failed start can be retried.
   */
  start(): Promise<this> {
    this._startPromise ??= this._start().catch((error) => {
      this._startPromise = undefined;
      throw error;
    });
    return this._startPromise;
  }

  /** Replace the active runner; without an argument, create one from the server options. */
  override async reload(runner?: EnvRunner) {
    this.runner = runner ?? (await this._createRunner());
    await super.reload(this.runner);
  }

  /**
   * Also kept in the server's own map, so runners it creates later (`reload()`,
   * watch mode) start with the changes. Without an active runner (before the
   * first start), the changes are only recorded.
   */
  override async updateVirtualModules(
    changes: VirtualModuleUpdates,
    timeout?: number,
  ): Promise<void> {
    const virtual = (this._virtual ??= {
      ...(this._opts.data?.virtual as VirtualModules | undefined),
    });
    for (const [key, source] of Object.entries(changes)) {
      if (source === null) {
        delete virtual[key];
      } else if (source !== undefined) {
        virtual[key] = source;
      }
    }
    if (await this._waitForRunner()) {
      await super.updateVirtualModules(changes, timeout);
    }
  }

  override async close() {
    this._stopWatching();
    await super.close();
  }

  // #region Private

  /** Auto-start on first fetch so an explicit `start()` call is optional. */
  protected override async _fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (!this.closed) {
      await this.start();
    }
    return super._fetch(input, init);
  }

  private async _start() {
    await this.reload();
    if (this._opts.watch) {
      this._startWatching();
    }
    return this;
  }

  protected override async _createRunner() {
    return loadRunner(this._opts.runner || "node-worker", {
      ...this._opts.runnerOptions,
      name: this._opts.name || this._opts.entry,
      hooks: this._opts.hooks,
      data: {
        ...this._opts.data,
        ...(this._virtual && { virtual: { ...this._virtual } }),
        entry: this._opts.entry,
      },
      execArgv: this._opts.execArgv,
    });
  }

  private _startWatching() {
    const paths = [this._opts.entry, ...(this._opts.watchPaths || [])];
    for (const path of paths) {
      try {
        const watcher = watchFile(path, { recursive: true }, () => {
          this._scheduleReload();
        });
        this._watchers.push(watcher);
      } catch {
        // Silently skip paths that cannot be watched
      }
    }
  }

  private _stopWatching() {
    clearTimeout(this._reloadTimeout);
    for (const watcher of this._watchers) {
      watcher.close();
    }
    this._watchers.length = 0;
  }

  private _scheduleReload() {
    clearTimeout(this._reloadTimeout);
    this._reloadTimeout = setTimeout(async () => {
      try {
        await this.reload();
        for (const fn of this._reloadListeners) fn();
      } catch (error) {
        console.error("Failed to reload runner:", error);
      }
    }, 100);
  }

  // #endregion
}
