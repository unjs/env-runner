import { createVirtualHooks, virtualModuleFormat } from "../virtual-loader.ts";

/**
 * Register runtime hooks that serve virtual modules from an in-memory
 * `specifier => source` map.
 *
 * Must be awaited before the user entry is imported so the hooks are active
 * when its (virtual) imports are resolved.
 *
 * Two registration backends, picked by feature detection:
 *
 * - **`module.registerHooks`** (Node.js >= 22.15 / 23.5, Deno >= 2.x) — wired
 *   with hooks from `createVirtualHooks()`. Detected via a dynamic import
 *   (never a static named import, which would throw at link time on runtimes
 *   without it). The dynamic import only runs when a non-empty `virtual` map
 *   is present, so workers without virtual modules never touch it.
 * - **`Bun.plugin` + `build.module()`** (Bun) — Bun's `node:module` lacks
 *   `registerHooks` (`module.register` exists but is a silent no-op), so each
 *   map entry is registered as a Bun virtual module instead. Registration
 *   mid-program affects subsequent dynamic imports, which is all the workers
 *   need. Bun matches `build.module` specifiers verbatim (no `?query`
 *   stripping), so reload cache-busting re-registers the specifier via
 *   {@link refreshVirtualModule} instead of appending a query.
 *
 * When neither backend is available a one-time warning is logged and
 * registration is skipped instead of crashing the worker.
 *
 * Resolves to an **unregister function** (idempotent) so the registration can
 * be released when the runner shuts down. On the `registerHooks` backend it
 * calls the returned `deregister()`, restoring default resolution for the
 * specifiers. Bun has no plugin-removal API, so there it detaches the live
 * source map instead: already-evaluated modules stay cached, but fresh loads
 * of the specifiers fail and {@link refreshVirtualModule} stops matching.
 */
export async function registerVirtualModules(
  virtual?: Record<string, string>,
): Promise<() => void> {
  if (!virtual || Object.keys(virtual).length === 0) {
    return _noop;
  }
  const { registerHooks } = await import("node:module");
  if (typeof registerHooks === "function") {
    const hooks = registerHooks(createVirtualHooks(virtual));
    return _once(() => hooks.deregister());
  }
  const bunPlugin = (globalThis as any).Bun?.plugin;
  if (typeof bunPlugin === "function") {
    _bunVirtual = virtual;
    _registerBunModules(Object.keys(virtual));
    return _once(() => {
      if (_bunVirtual === virtual) {
        _bunVirtual = undefined;
      }
    });
  }
  console.warn(
    "[env-runner] virtual modules require `module.registerHooks` (Node.js >= 22.15 / Deno >= 2.x) or `Bun.plugin`; skipping registration.",
  );
  return _noop;
}

/**
 * Force a fresh evaluation of a Bun-registered virtual module by re-registering
 * its specifier (Bun busts the module cache on override). Returns `false` when
 * the specifier wasn't registered through the Bun backend — `registerHooks`
 * runtimes cache-bust with a `?query` suffix instead.
 *
 * Only the given specifier is refreshed; virtual modules it imports keep their
 * cached instances, matching the `registerHooks` reload semantics (a query
 * suffix gives the entry a new identity while its imports resolve to the same
 * `virtual:` URLs).
 */
export function refreshVirtualModule(specifier: string): boolean {
  if (_bunVirtual?.[specifier] === undefined) {
    return false;
  }
  _registerBunModules([specifier]);
  return true;
}

let _bunVirtual: Record<string, string> | undefined;

// Load callbacks read from the live `_bunVirtual` map (not a captured source)
// so unregistering — detaching the map — disables fresh loads even though
// Bun's plugin API offers no way to remove a `build.module` registration.
function _registerBunModules(specifiers: string[]): void {
  (globalThis as any).Bun.plugin({
    name: "env-runner-virtual",
    setup(build: any) {
      for (const specifier of specifiers) {
        build.module(specifier, () => {
          const source = _bunVirtual?.[specifier];
          if (source === undefined) {
            throw new Error(`Cannot find virtual module "${specifier}" (unregistered)`);
          }
          return { contents: source, loader: _bunLoader(specifier) };
        });
      }
    },
  });
}

// Map the shared format detection (extension-based) to Bun plugin loaders.
function _bunLoader(specifier: string): "js" | "ts" | "json" {
  const format = virtualModuleFormat(specifier);
  return format === "module" ? "js" : format === "module-typescript" ? "ts" : "json";
}

const _noop = () => {};

function _once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
}
