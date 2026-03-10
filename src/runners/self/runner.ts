import type { WorkerHooks } from "../../types.ts";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import type { AppEntry } from "../../common/worker-utils.ts";
import { resolveEntry } from "../../common/worker-utils.ts";

export type { EnvRunnerData as SelfEnvRunnerData } from "../../common/base-runner.ts";

export class SelfEnvRunner extends BaseEnvRunner {
  #active = false;
  #entry?: AppEntry;

  constructor(opts: {
    name: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    super({ ...opts, workerEntry: "" });
    this.#init();
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.#entry || this.closed) {
      return new Response("self env runner is unavailable", { status: 503 });
    }
    const request = input instanceof Request ? input : new Request(input, init);
    return this.#entry.fetch(request) as Promise<Response>;
  }

  sendMessage(message: unknown) {
    if (!this.#active) {
      throw new Error("Self env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally (no worker to relay to)
    if ((message as any)?.type === "ping") {
      queueMicrotask(() =>
        this._handleMessage({ type: "pong", data: (message as any).data }),
      );
    }
  }

  // #region Protected methods

  protected _hasRuntime() {
    return this.#active;
  }

  protected _runtimeType() {
    return "self";
  }

  protected async _closeRuntime() {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#entry = undefined;
  }

  // #endregion

  // #region Private methods

  #init() {
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      this.close("self runner requires data.entry");
      return;
    }
    this.#active = true;
    resolveEntry(entryPath)
      .then((entry) => {
        this.#entry = entry;
        // Signal ready with a dummy address (fetch is overridden, address unused)
        this._handleMessage({ address: { host: "127.0.0.1", port: 0 } });
      })
      .catch((error) => {
        console.error("Self runner entry error:", error);
        this.close(error);
      });
  }

  // #endregion
}
