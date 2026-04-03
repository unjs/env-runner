import type { WorkerHooks } from "../../types.ts";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData } from "../../common/base-runner.ts";
import type { AppEntry } from "../../common/worker-utils.ts";
import { resolveEntry, reloadEntryModule } from "../../common/worker-utils.ts";

export type { EnvRunnerData as SelfEnvRunnerData } from "../../common/base-runner.ts";

interface NodeWSAdapter {
  handleUpgrade: (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: any,
  ) => Promise<void>;
  closeAll: (code?: number, data?: string, force?: boolean) => void;
}

export class SelfEnvRunner extends BaseEnvRunner {
  #active = false;
  #entry?: AppEntry;
  #wsAdapter?: NodeWSAdapter;

  constructor(opts: { name: string; hooks?: WorkerHooks; data?: EnvRunnerData }) {
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

  override async upgrade(context: {
    node: {
      req: import("node:http").IncomingMessage;
      socket: import("node:net").Socket;
      head: any;
    };
  }) {
    if (!this.#entry || this.closed) {
      return;
    }
    if (this.#entry.websocket) {
      const adapter = await this.#resolveWSAdapter();
      await adapter.handleUpgrade(context.node.req, context.node.socket, context.node.head);
      return;
    }
    this.#entry.upgrade?.(context);
  }

  sendMessage(message: unknown) {
    if (!this.#active) {
      throw new Error("Self env runner should be initialized before sending messages.");
    }
    // Handle ping/pong internally (no worker to relay to)
    if ((message as any)?.type === "ping") {
      queueMicrotask(() => this._handleMessage({ type: "pong", data: (message as any).data }));
      return;
    }
    this.#entry?.ipc?.onMessage?.(message);
  }

  override async reloadModule(): Promise<void> {
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath || !this.#entry) {
      throw new Error("Cannot reload: no entry loaded");
    }
    const sendFn = (message: unknown) => {
      queueMicrotask(() => this._handleMessage(message));
    };
    this.#wsAdapter?.closeAll(1001, undefined, true);
    this.#wsAdapter = undefined;
    this.#entry = await reloadEntryModule(entryPath, this.#entry, sendFn);
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
    this.#wsAdapter?.closeAll(1001, undefined, true);
    this.#wsAdapter = undefined;
    await this.#entry?.ipc?.onClose?.();
    this.#entry = undefined;
  }

  // #endregion

  // #region Private methods

  async #resolveWSAdapter(): Promise<NodeWSAdapter> {
    if (!this.#wsAdapter) {
      const { default: nodeAdapter } = await import("crossws/adapters/node");
      this.#wsAdapter = nodeAdapter({ hooks: this.#entry!.websocket! });
    }
    return this.#wsAdapter;
  }

  #init() {
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath) {
      this.close("self runner requires data.entry");
      return;
    }
    this.#active = true;
    resolveEntry(entryPath)
      .then(async (entry) => {
        this.#entry = entry;
        await entry.ipc?.onOpen?.({
          sendMessage: (message) => {
            queueMicrotask(() => this._handleMessage(message));
          },
        });
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
