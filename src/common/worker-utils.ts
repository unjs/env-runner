import type { ServerOptions, Server } from "srvx";
import type { Hooks } from "crossws";
import type { UpgradeContext } from "../types.ts";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { refreshVirtualModule } from "./virtual-modules.ts";

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
}

/** Worker-owned srvx options: the worker listens on a random loopback port behind the proxy. */
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

/** Callers add `fetch` (bound lazily so reloads swap it) and the crossws plugin. */
export function toServerOptions(entry: AppEntry): Omit<ServerOptions, "fetch"> {
  const { fetch: _fetch, upgrade: _upgrade, websocket: _websocket, ipc: _ipc, ...options } = entry;
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
  return {
    ...options,
    port: 0,
    hostname: "127.0.0.1",
    silent: true,
    gracefulShutdown: false,
  };
}

/** Virtual modules override real files with the same name. */
export function isVirtualSpecifier(
  specifier: string | undefined,
  virtual?: Record<string, string>,
): boolean {
  return Boolean(specifier && virtual && Object.hasOwn(virtual, specifier));
}

export async function resolveEntry(entryPath: string, virtual?: boolean): Promise<AppEntry> {
  // Virtual specifiers are matched verbatim by the registered resolve hook —
  // don't convert path-shaped ones to file:// URLs.
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

export function parseServerAddress(server: Server): { host: string; port: number } {
  const url = new URL(server.url!);
  return { host: url.hostname, port: Number(url.port) };
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

  // Re-import with fresh content via data: URL to bypass module cache across all runtimes
  const newEntry = await _importFresh(entryPath, virtual);

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

let _reloadCounter = 0;

async function _importFresh(entryPath: string, virtual?: boolean): Promise<AppEntry> {
  const qIndex = entryPath.indexOf("?");
  const filePath = qIndex === -1 ? entryPath : entryPath.slice(0, qIndex);

  let mod: any;
  if (!virtual && existsSync(filePath)) {
    // Real file: re-read latest content via data: URL to bypass the module cache.
    const code = readFileSync(filePath, "utf8");
    const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
    mod = await import(dataUrl);
  } else if (virtual && refreshVirtualModule(filePath)) {
    // Bun matches specifiers verbatim (no `?query`); re-registering busted the cache.
    mod = await import(filePath);
  } else {
    // Virtual or bare specifier (e.g. served by registered ESM hooks): re-import
    // through the resolver with a cache-busting query for a fresh evaluation.
    const sep = qIndex === -1 ? "?" : "&";
    mod = await import(entryPath + sep + "__envRunnerReload=" + _reloadCounter++);
  }

  const entry = mod.default || mod;
  if (typeof entry.fetch !== "function") {
    throw new Error(
      `[env-runner] Entry module "${entryPath}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`,
    );
  }
  return entry as AppEntry;
}
