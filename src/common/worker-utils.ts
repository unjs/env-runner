import type { ServerOptions, Server } from "srvx";

export interface AppEntry {
  fetch: ServerOptions["fetch"];
  middleware?: ServerOptions["middleware"];
  plugins?: ServerOptions["plugins"];
}

export async function resolveEntry(entryPath: string): Promise<AppEntry> {
  const mod = await import(entryPath);
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
