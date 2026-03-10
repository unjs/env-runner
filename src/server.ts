import { type FSWatcher, watch as watchFile } from "node:fs";
import type { WorkerHooks } from "./types.ts";
import type { RunnerName } from "./loader.ts";

import { loadRunner } from "./loader.ts";
import { RunnerManager } from "./manager.ts";

export interface EnvServerOptions {
  /** Runner implementation to use. */
  runner: RunnerName;
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
}

export class EnvServer extends RunnerManager {
  private _opts: EnvServerOptions;
  private _watchers: FSWatcher[] = [];
  private _reloadTimeout: ReturnType<typeof setTimeout> | undefined;
  private _reloadListeners = new Set<() => void>();

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

  /** Start the server by loading and attaching the runner. */
  async start() {
    this.runner = await this._createRunner();
    await this.reload(this.runner);
    if (this._opts.watch) {
      this._startWatching();
    }
    return this;
  }

  override async close() {
    this._stopWatching();
    await super.close();
  }

  // #region Private

  private async _createRunner() {
    return loadRunner(this._opts.runner, {
      name: this._opts.name || this._opts.entry,
      hooks: this._opts.hooks,
      data: { ...this._opts.data, entry: this._opts.entry },
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
        this.runner = await this._createRunner();
        await this.reload(this.runner);
        for (const fn of this._reloadListeners) fn();
      } catch (error) {
        console.error("Failed to reload runner:", error);
      }
    }, 100);
  }

  // #endregion
}
