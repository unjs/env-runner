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

export interface AppEntry {
  fetch: ServerOptions["fetch"];
  upgrade?: (context: UpgradeContext) => void;
  websocket?: Partial<Hooks>;
  middleware?: ServerOptions["middleware"];
  plugins?: ServerOptions["plugins"];
  ipc?: AppEntryIPC;
}

/**
 * `true` when the specifier is served from the `data.virtual` map, so entry
 * loading can skip filesystem path handling even if a real file with the same
 * name exists (the virtual module overrides it).
 */
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

/**
 * Re-import the user entry module with cache busting.
 * Tears down old IPC hooks and re-initializes new ones.
 */
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
    // Bun-registered virtual module: `build.module` matches specifiers verbatim
    // (a `?query` suffix would not resolve), so the re-registration above busts
    // the cache and a plain re-import evaluates fresh.
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
