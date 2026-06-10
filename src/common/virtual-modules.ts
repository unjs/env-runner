import { createVirtualHooks } from "../virtual-loader.ts";

/**
 * Register Node.js ESM hooks that serve virtual modules from an in-memory
 * `specifier => source` map.
 *
 * Must be awaited before the user entry is imported so the hooks are active
 * when its (virtual) imports are resolved.
 *
 * `module.registerHooks` is feature-detected via a dynamic import (never a
 * static named import, which would throw at link time on runtimes without it):
 * Node.js < 22.15 / 23.5 and older Deno log a one-time warning and skip
 * registration instead of crashing the worker. The dynamic import only runs
 * when a non-empty `virtual` map is present, so workers without virtual
 * modules never touch it.
 */
export async function registerVirtualModules(virtual?: Record<string, string>): Promise<void> {
  if (!virtual || Object.keys(virtual).length === 0) {
    return;
  }
  const { registerHooks } = await import("node:module");
  if (typeof registerHooks !== "function") {
    console.warn(
      "[env-runner] virtual modules require `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.x); skipping registration.",
    );
    return;
  }
  registerHooks(createVirtualHooks(virtual));
}
