import type { ServerOptions, Server } from "srvx";
import type { Hooks } from "crossws";
import type { UpgradeContext } from "../types.ts";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";

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

export async function resolveEntry(entryPath: string): Promise<AppEntry> {
  const importPath = _toImportPath(entryPath);
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
): Promise<AppEntry> {
  // Tear down old IPC
  await currentEntry.ipc?.onClose?.();

  // Re-import with fresh content via data: URL to bypass module cache across all runtimes
  const newEntry = await _importFresh(entryPath);

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

async function _importFresh(entryPath: string): Promise<AppEntry> {
  const code = readFileSync(entryPath, "utf8");
  const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  const mod = await import(dataUrl);
  const entry = mod.default || mod;
  if (typeof entry.fetch !== "function") {
    throw new Error(
      `[env-runner] Entry module "${entryPath}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`,
    );
  }
  return entry as AppEntry;
}
