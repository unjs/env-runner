import type { WorkerHooks } from "../../types.ts";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData, EnvRunnerPluginOption } from "../../common/base-runner.ts";
import type { AppEntry } from "../../common/worker-utils.ts";
import {
  importFreshEntry,
  isVirtualEntry,
  resolveEntry,
  reloadEntryModule,
} from "../../common/worker-utils.ts";
import { registerOwnedVirtualModules } from "../../common/virtual-modules.ts";
import { createDirectTransformClient } from "../../plugin/channel.ts";
import { registerPluginHooks } from "../../plugin/hooks.ts";
import type { OwnedVirtualModules } from "../../common/virtual-modules.ts";
import type { ResolvedVirtualModule } from "../../virtual-loader.ts";

export type { EnvRunnerData as SelfEnvRunnerData } from "../../common/base-runner.ts";

interface NodeWSAdapter {
  handleUpgrade: (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: any,
  ) => Promise<void>;
  closeAll: (code?: number, data?: string, force?: boolean) => void;
}

// Entries imported by self runners in this process.
const _importedEntries = new Set<string>();

export class SelfEnvRunner extends BaseEnvRunner {
  #active = false;
  #entry?: AppEntry;
  #wsAdapter?: NodeWSAdapter;
  #virtual?: OwnedVirtualModules;
  #unregisterPlugins?: () => void;

  constructor(opts: {
    name: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
    /**
     * Run in this process's loader hooks, so their handlers must be
     * synchronous (virtual modules are still transformed before they are
     * registered, where async handlers work).
     */
    plugins?: EnvRunnerPluginOption[];
  }) {
    super({ ...opts, workerEntry: "" });
    this.#init();
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!this.#entry || this.closed) {
      return new Response("self env runner is unavailable", { status: 503 });
    }
    const request =
      input instanceof Request ? input : new Request(this._resolveFetchInput(input), init);
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
    try {
      if (this.#entry.websocket) {
        const adapter = await this.#resolveWSAdapter();
        await adapter.handleUpgrade(context.node.req, context.node.socket, context.node.head);
        return;
      }
      this.#entry.upgrade?.(context);
    } catch {
      // No upstream settles the socket when the entry throws, so destroy it here.
      if (!context.node.socket.destroyed) {
        context.node.socket.destroy();
      }
    }
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

  /** Same as `close()`, which runs `ipc.onClose` (there is no server to drain). */
  override async shutdown(): Promise<void> {
    await this.close();
  }

  override async reloadModule(): Promise<void> {
    await this._virtualUpdates;
    const entryPath = this._data?.entry as string | undefined;
    if (!entryPath || !this.#entry) {
      throw new Error("Cannot reload: no entry loaded");
    }
    const sendFn = (message: unknown) => {
      queueMicrotask(() => this._handleMessage(message));
    };
    this.#wsAdapter?.closeAll(1001, undefined, true);
    this.#wsAdapter = undefined;
    this.#entry = await reloadEntryModule(
      entryPath,
      this.#entry,
      sendFn,
      isVirtualEntry(entryPath, this.#virtual?.modules()),
    );
  }

  // #region Protected methods

  protected _hasRuntime() {
    return this.#active;
  }

  protected _runtimeType() {
    return "self";
  }

  // Applied in the host process, where the entry is imported.
  protected override async _applyVirtualUpdates(
    changes: Record<string, ResolvedVirtualModule | null>,
  ): Promise<void> {
    await this.#virtual!.update(changes);
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
    this.#virtual?.unregister();
    this.#unregisterPlugins?.();
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
    // Requests come from the host's own server.
    if (this._rejectListen()) {
      return;
    }
    this._initWithVirtualData(() => {
      this.#active = true;
      this.#start(entryPath).catch((error) => {
        console.error("Self runner entry error:", error);
        this.close(error);
      });
    });
  }

  async #start(entryPath: string) {
    // Process-global hooks, owned by this runner (its updates change only them).
    const registerVirtual = () =>
      registerOwnedVirtualModules(
        this._data?.virtual as Record<string, ResolvedVirtualModule> | undefined,
      );
    // Virtual keys win over the plugin hooks, as in workers
    // (`registerWorkerHooks()`): the latest `registerHooks` registration runs
    // first, Bun asks the earliest `onLoad` whose filter matches.
    const bun = "Bun" in globalThis;
    const virtualFirst = bun ? await registerVirtual() : undefined;
    // The plugins run synchronously in the hooks: no worker blocks for them.
    const unregisterPlugins = this._plugins
      ? await registerPluginHooks(
          {
            prefilters: this._plugins.prefilters,
            resolvePrefilters: this._plugins.resolvePrefilters,
          },
          entryPath,
          createDirectTransformClient(this._plugins),
        )
      : undefined;
    const virtual = virtualFirst ?? (await registerVirtual());
    if (this.closed) {
      virtual.unregister();
      unregisterPlugins?.();
      return;
    }
    this.#virtual = virtual;
    this.#unregisterPlugins = unregisterPlugins;
    const isVirtual = isVirtualEntry(entryPath, virtual.modules());
    // The module cache is process-wide: a later runner for the same entry gets
    // its own instance (and its own virtual modules).
    const entry = _importedEntries.has(entryPath)
      ? await importFreshEntry(entryPath, isVirtual)
      : await resolveEntry(entryPath, isVirtual);
    _importedEntries.add(entryPath);
    // Closed mid-import: don't open IPC that `_closeRuntime()` will never close.
    if (this.closed) {
      return;
    }
    this.#entry = entry;
    await entry.ipc?.onOpen?.({
      sendMessage: (message) => {
        queueMicrotask(() => this._handleMessage(message));
      },
    });
    // Signal ready with a dummy address (fetch is overridden, address unused)
    this._handleMessage({ address: { host: "127.0.0.1", port: 0 } });
  }

  // #endregion
}
