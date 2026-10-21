import type { ServerOptions, Server } from "srvx";
import type { Hooks } from "crossws";
import type { ListenOptions, UpgradeContext, WorkerAddress } from "../types.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import {
  refreshVirtualModule,
  registeredVirtualModules,
  registerVirtualModules,
} from "./virtual-modules.ts";
import { PLUGINS_DATA_KEY, registerPluginHooks, servedByPluginHooks } from "../plugin/hooks.ts";
import { findVirtualPathKey } from "../virtual-loader.ts";

export interface AppEntryIPCContext {
  sendMessage: (message: unknown) => void;
}

export interface AppEntryIPC {
  onOpen?: (ctx: AppEntryIPCContext) => void | Promise<void>;
  onMessage?: (message: unknown) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}

/**
 * User entry module. Other srvx `ServerOptions` are forwarded to `serve()`,
 * except {@link RESERVED_SERVER_OPTIONS}.
 */
export interface AppEntry extends Omit<ServerOptions, "fetch"> {
  fetch: ServerOptions["fetch"];
  upgrade?: (context: UpgradeContext) => void;
  websocket?: Partial<Hooks>;
  ipc?: AppEntryIPC;
  /**
   * Miniflare only: the module whose named exports provide the Worker's
   * Durable Object, `WorkerEntrypoint` and `WorkflowEntrypoint` classes
   * (default: the entry module). Called on each use, so it can follow reloads.
   */
  resolveExports?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** Runner data key of the `listen` runner option (only set with it). */
export const LISTEN_DATA_KEY = "__envRunnerListen";

/**
 * Worker-owned srvx options: the worker listens on a random loopback port
 * behind the proxy, or on the runner's `listen` address.
 */
export const RESERVED_SERVER_OPTIONS = [
  "port",
  "hostname",
  "protocol",
  "tls",
  "silent",
  "manual",
  "gracefulShutdown",
] as const satisfies (keyof ServerOptions)[];

/**
 * srvx spreads `node`/`bun`/`deno` after its resolved listener options, so
 * these would bypass {@link RESERVED_SERVER_OPTIONS}. `node.http2` needs TLS.
 */
export const RESERVED_RUNTIME_OPTIONS = {
  node: ["port", "host", "path", "http2", "cert", "key", "passphrase"],
  bun: ["port", "hostname", "unix", "tls"],
  deno: ["port", "hostname", "path", "cert", "key"],
} as const satisfies Record<"node" | "bun" | "deno", readonly string[]>;

/**
 * Callers add `fetch` (bound lazily so reloads swap it) and the crossws plugin.
 * `listen`: the runner's `listen` option (`data[LISTEN_DATA_KEY]`).
 */
export function toServerOptions(
  entry: AppEntry,
  listen?: ListenOptions,
): Omit<ServerOptions, "fetch"> {
  const {
    fetch: _fetch,
    upgrade: _upgrade,
    websocket: _websocket,
    ipc: _ipc,
    resolveExports: _resolveExports,
    ...options
  } = entry;
  for (const key of RESERVED_SERVER_OPTIONS) {
    delete options[key];
  }
  for (const runtime of Object.keys(
    RESERVED_RUNTIME_OPTIONS,
  ) as (keyof typeof RESERVED_RUNTIME_OPTIONS)[]) {
    if (options[runtime]) {
      const runtimeOptions: Record<string, unknown> = { ...options[runtime] };
      for (const key of RESERVED_RUNTIME_OPTIONS[runtime]) {
        delete runtimeOptions[key];
      }
      options[runtime] = runtimeOptions;
    }
  }
  // The host owns signals (`shutdown()`), also with a public listener.
  if (listen) {
    // `reusePort` isn't worker-owned: the entry's applies unless `listen` sets it.
    const { port, hostname, protocol, tls, reusePort = options.reusePort, silent = true } = listen;
    return {
      ...options,
      port,
      hostname,
      protocol,
      tls,
      reusePort,
      silent,
      gracefulShutdown: false,
    };
  }
  return {
    ...options,
    // Bun closes connections idle for 10s by default, also while a slow
    // response (cold SSR) is pending. The host proxy owns client timeouts.
    bun: { idleTimeout: 0, ...options.bun },
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  };
}

/**
 * Virtual modules override real files with the same name. Exact key match by
 * default (Bun, where a differently spelled `file:` entry would reload stale).
 * `matchPaths` also matches a path key naming the same file (`/app/x.mjs` for
 * `file:///app/x.mjs`), as the `registerHooks` resolver does.
 */
export function isVirtualSpecifier(
  specifier: string | undefined,
  virtual?: Record<string, unknown>,
  matchPaths = false,
): boolean {
  if (!specifier || !virtual) {
    return false;
  }
  return (
    Object.hasOwn(virtual, specifier) ||
    (matchPaths && findVirtualPathKey(virtual, specifier) !== undefined)
  );
}

/**
 * Worker-side {@link isVirtualSpecifier} for `data.entry`, matching the backend
 * that serves `data.virtual`: path-aware with `module.registerHooks` (Node,
 * Deno), so load and reload both stay virtual; exact on Bun. Checks the live
 * registrations by default, which follow updates.
 */
export function isVirtualEntry(
  entry: string | undefined,
  virtual: Record<string, unknown> | undefined = registeredVirtualModules(),
): boolean {
  const registerHooks = process.getBuiltinModule?.("node:module")?.registerHooks;
  return isVirtualSpecifier(entry, virtual, typeof registerHooks === "function");
}

/**
 * Register the loader hooks for the runner's `plugins` and `data.virtual`;
 * await before importing the entry. Resolves to an idempotent unregister
 * function.
 */
export async function registerWorkerHooks(data: Record<string, any>): Promise<() => void> {
  // Virtual modules must win for keys overriding a file. The latest
  // `registerHooks` registration runs first, but Bun asks the earliest
  // `onLoad` whose filter matches.
  const bun = "Bun" in globalThis;
  const unregisterVirtualFirst = bun ? await registerVirtualModules(data.virtual) : undefined;
  const unregisterPlugins = await registerPluginHooks(data[PLUGINS_DATA_KEY], data.entry);
  const unregisterVirtual = unregisterVirtualFirst ?? (await registerVirtualModules(data.virtual));
  return () => {
    unregisterVirtual();
    unregisterPlugins();
  };
}

export async function resolveEntry(entryPath: string, virtual?: boolean): Promise<AppEntry> {
  // Import virtual keys verbatim: Bun matches extensionless keys as-is and drops
  // `file:` queries (`registerHooks` resolves path keys by URL either way).
  const importPath = virtual ? entryPath : _toImportPath(entryPath);
  const mod = await import(importPath);
  const entry = mod.default || mod;
  if (typeof entry.fetch !== "function") {
    throw new Error(
      `[env-runner] Entry module "${entryPath}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`,
    );
  }
  return entry as AppEntry;
}

/**
 * Init error as one line: the message, plus where it was thrown when the
 * message doesn't say. Stacks name virtual modules (`virtual:#config:2:7`),
 * messages mostly don't. env-runner's own errors are left as they are.
 */
export function formatInitError(error: any): string {
  // Deno prefixes errors thrown by module hooks with their name.
  const message = (error?.message || String(error)).replace(/^(?:Error: )+(?=\[env-runner\])/, "");
  if (message.startsWith("[env-runner]") || /:\d+:\d+/.test(message)) {
    return message;
  }
  const location = _errorLocation(error);
  return location ? `${message} (at ${location})` : message;
}

// Bun's syntax errors (`BuildMessage`) have a position but no stack. Node puts
// the failing line of link and TypeScript errors above the stack header
// (`virtual:#config:1`). Else the first stack frame with a location.
function _errorLocation(error: any): string | undefined {
  const position = error?.position;
  if (position?.file) {
    return `${position.file}:${position.line}:${position.column}`;
  }
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const location = stack.startsWith(String(error?.name))
    ? /\n\s+at (?:async )?(?:.* \()?([^\n()]+:\d+:\d+)\)?/.exec(stack)?.[1]
    : /^([^\n]+:\d+)\n/.exec(stack)?.[1];
  // Runtime internals (Node, Deno, Bun) don't help.
  return location && !/^(?:node|ext|native):/.test(location) ? location : undefined;
}

/**
 * The address the host reaches the server at: IPv6 hosts unbracketed, and
 * wildcard ones (a `listen` option on all interfaces) as loopback.
 */
export function parseServerAddress(server: Server): WorkerAddress {
  const url = new URL(server.url!);
  const https = url.protocol === "https:";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return {
    host: host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host,
    // Empty for the protocol's default port.
    port: Number(url.port) || (https ? 443 : 80),
    ...(https && { protocol: "https" }),
  };
}

/**
 * Graceful shutdown (the `shutdown` message): stop accepting connections and
 * wait for in-flight requests, then run `ipc.onClose`. Never rejects (errors
 * are logged), so the worker always replies `exit`.
 *
 * `server.close()` also waits for open WebSockets (Node.js, Bun), so with the
 * host's `timeout` the wait ends halfway through it, leaving `ipc.onClose`
 * the rest (the host terminates the worker after `exit`).
 */
export async function shutdownWorker(
  server: Server,
  entry: AppEntry,
  timeout?: number,
): Promise<void> {
  await closeServerGracefully(server, typeof timeout === "number" ? timeout / 2 : undefined);
  await Promise.resolve()
    .then(() => entry.ipc?.onClose?.())
    .catch((error) => {
      console.error("[env-runner] `ipc.onClose` failed:", error);
    });
}

/**
 * Stop accepting connections and wait for in-flight requests (and open
 * WebSockets), for `timeout` ms at most. Never rejects (errors are logged).
 */
export async function closeServerGracefully(server: Server, timeout?: number): Promise<void> {
  const closed = server.close().catch((error) => {
    console.error("[env-runner] failed to close the worker server:", error);
  });
  if (typeof timeout === "number") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise((resolve) => (timer = setTimeout(resolve, timeout)))]);
    clearTimeout(timer);
  } else {
    await closed;
  }
}

/** Re-import the user entry (cache-busted) and re-init its IPC hooks. */
export async function reloadEntryModule(
  entryPath: string,
  currentEntry: AppEntry,
  sendMessage: (message: unknown) => void,
  virtual?: boolean,
): Promise<AppEntry> {
  // Tear down old IPC
  await currentEntry.ipc?.onClose?.();

  // Re-import a fresh instance, bypassing the module cache
  const newEntry = await importFreshEntry(entryPath, virtual);

  // Re-initialize IPC
  await newEntry.ipc?.onOpen?.({ sendMessage });

  return newEntry;
}

function _toImportPath(entryPath: string): string {
  const qIndex = entryPath.indexOf("?");
  const filePath = qIndex === -1 ? entryPath : entryPath.slice(0, qIndex);
  const query = qIndex === -1 ? "" : entryPath.slice(qIndex);
  if (isAbsolute(filePath)) {
    return pathToFileURL(filePath).href + query;
  }
  return entryPath;
}

// Bun ignores a query on `file:` URLs (returning the cached module) but honors
// it on paths; Node/Deno need `file:` URLs for absolute paths (`C:\`).
function _toReloadPath(entryPath: string): string {
  if (!("Bun" in globalThis)) {
    return _toImportPath(entryPath);
  }
  if (!entryPath.startsWith("file:")) {
    return entryPath;
  }
  const qIndex = entryPath.indexOf("?");
  return qIndex === -1
    ? fileURLToPath(entryPath)
    : fileURLToPath(entryPath.slice(0, qIndex)) + entryPath.slice(qIndex);
}

let _reloadCounter = 0;

/**
 * Import a fresh instance of the entry (cache-busting query; Bun: evicted or
 * refreshed). Its own dependencies stay cached.
 */
export async function importFreshEntry(entryPath: string, virtual?: boolean): Promise<AppEntry> {
  const qIndex = entryPath.indexOf("?");
  const filePath = qIndex === -1 ? entryPath : entryPath.slice(0, qIndex);

  let mod: any;
  const bunPath = filePath.startsWith("file:") ? fileURLToPath(filePath) : filePath;
  if (!virtual && "Bun" in globalThis && servedByPluginHooks(bunPath)) {
    // Bun drops the query of a file served by the plugins' `onLoad`: evict it
    // instead (`require.cache` also holds ESM there, by path).
    delete createRequire(import.meta.url).cache[bunPath];
    mod = await import(bunPath);
  } else if (virtual && refreshVirtualModule(filePath)) {
    // Bun: `refreshVirtualModule()` bumped or re-registered the key (a `?query`
    // doesn't reach every key there).
    mod = await import(filePath);
  } else {
    // Re-import through the resolver with a cache-busting query: a fresh
    // instance under a real identity (virtual key or file), so relative imports
    // and `import.meta` keep working. The entry's own dependencies stay cached.
    const importPath = virtual ? entryPath : _toReloadPath(entryPath);
    const sep = importPath.includes("?") ? "&" : "?";
    mod = await import(importPath + sep + "__envRunnerReload=" + _reloadCounter++);
  }

  const entry = mod.default || mod;
  if (typeof entry.fetch !== "function") {
    throw new Error(
      `[env-runner] Entry module "${entryPath}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`,
    );
  }
  return entry as AppEntry;
}
