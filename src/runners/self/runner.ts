import type { Server } from "srvx";
import type { Socket } from "node:net";
import type { ListenOptions, WorkerHooks } from "../../types.ts";

import { BaseEnvRunner } from "../../common/base-runner.ts";
import type { EnvRunnerData, EnvRunnerPluginOption } from "../../common/base-runner.ts";
import type { AppEntry } from "../../common/worker-utils.ts";
import {
  closeServerGracefully,
  importFreshEntry,
  isVirtualEntry,
  parseServerAddress,
  resolveEntry,
  reloadEntryModule,
  toServerOptions,
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
  // The `listen` option's server, and its Node.js sockets (upgraded ones included).
  #server?: Server;
  #sockets = new Set<Socket>();

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
    /**
     * Serve the entry on this public address from the host process, with its
     * srvx options (see {@link ListenOptions}).
     */
    listen?: ListenOptions;
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
    // Through the server's middleware and plugins, as the worker runners proxy.
    if (this.#server) {
      return this.#server.fetch(request) as Promise<Response>;
    }
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

  /**
   * With `listen`, first stop accepting connections and wait for in-flight
   * requests (for half of `timeout` at most, since open WebSockets keep it
   * waiting); then `close()`, which runs `ipc.onClose`.
   */
  override async shutdown(timeout = 5000): Promise<void> {
    if (this.#server && this.ready) {
      await closeServerGracefully(this.#server, timeout / 2);
    }
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
    if (this.#server) {
      const closed = this.#server.close(true);
      // `closeAll` leaves upgraded sockets (WebSockets) open on Node.js.
      for (const socket of this.#sockets) {
        socket.destroy();
      }
      this.#sockets.clear();
      this.#server = undefined;
      await closed;
    }
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
    const server = this._listen ? await this.#serve(entry, this._listen) : undefined;
    if (this.closed) {
      // Closed before it listened, which `_closeRuntime()` couldn't stop.
      await server?.close(true);
      return;
    }
    this.#entry = entry;
    await entry.ipc?.onOpen?.({
      sendMessage: (message) => {
        queueMicrotask(() => this._handleMessage(message));
      },
    });
    // Without `listen`, a dummy address (fetch is overridden, address unused).
    this._handleMessage({
      address: server ? parseServerAddress(server) : { host: "127.0.0.1", port: 0 },
    });
  }

  /** The `listen` option: serve the entry like the workers do. */
  async #serve(entry: AppEntry, listen: ListenOptions): Promise<Server> {
    const [{ serve }, wsPlugin] = await Promise.all([
      import("srvx"),
      entry.websocket ? import("crossws/server").then((m) => m.plugin) : undefined,
    ]);
    // `this.#entry` follows reloads (it is set once the server is ready).
    const current = () => this.#entry ?? entry;
    const server = serve({
      ...toServerOptions(entry, listen),
      fetch: (request) => current().fetch(request),
      plugins: [...(entry.plugins || []), ...(wsPlugin ? [wsPlugin(entry.websocket!)] : [])],
    });
    // Before `ready()`, so a close meanwhile closes it.
    this.#server = server;
    server.node?.server?.on("connection", (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    if (entry.upgrade) {
      server.node?.server?.on("upgrade", (req, socket, head) => {
        current().upgrade?.({ node: { req, socket, head } });
      });
    }
    await server.ready();
    return server;
  }

  // #endregion
}
