import {
  createVirtualHooks,
  expandVirtualInvalidation,
  stripVirtualTypeScript,
  virtualModuleFormat,
} from "../virtual-loader.ts";

/**
 * Serve virtual modules; await before importing the entry. Format follows the
 * extension ({@link virtualModuleFormat}); Deno sources are pre-transformed.
 *
 * Backends: `module.registerHooks` (Node >= 22.15 / 23.5, Deno), imported
 * dynamically since a static named import fails to link where it's missing;
 * or `Bun.plugin` (Bun's `module.register` is a silent no-op). Warns once and
 * skips when neither exists.
 *
 * Resolves to an idempotent unregister function. Bun can't remove plugins, so
 * there it detaches the source map (cached modules survive, fresh loads fail).
 */
export async function registerVirtualModules(
  virtual?: Record<string, string>,
): Promise<() => void> {
  if (!virtual || Object.keys(virtual).length === 0) {
    return _noop;
  }
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  if (typeof registerHooks === "function") {
    const isDeno = "Deno" in globalThis;
    let transformSource: ((specifier: string, source: string) => string) | undefined;
    if (isDeno) {
      transformSource = (specifier, source) =>
        _transformSourceForDeno(specifier, source, stripTypeScriptTypes);
      const transformed: Record<string, string> = {};
      for (const [specifier, source] of Object.entries(virtual)) {
        transformed[specifier] = transformSource(specifier, source);
      }
      virtual = transformed;
    }
    const registration: HooksRegistration = {
      virtual,
      versions: new Map(),
      transformSource,
    };
    // Track only after registerHooks succeeds (a throw returns no unregister).
    // Deno sources are already plain JS, so force the `module` format.
    const hooks = registerHooks(
      createVirtualHooks(virtual, registration.versions, undefined, isDeno),
    );
    _hooksRegistrations.unshift(registration);
    return _once(() => {
      const index = _hooksRegistrations.indexOf(registration);
      if (index !== -1) {
        _hooksRegistrations.splice(index, 1);
      }
      hooks.deregister();
    });
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
 * Re-register a Bun virtual module to bust its cache (Bun matches specifiers
 * verbatim, so `?query` busting doesn't work). Its imports stay cached, like
 * on `registerHooks`. `false` when not Bun-registered.
 */
export function refreshVirtualModule(specifier: string): boolean {
  if (_bunVirtual?.[specifier] === undefined) {
    return false;
  }
  _registerBunModules([specifier]);
  return true;
}

/**
 * Make the next import of a virtual module (and its virtual importers, see
 * {@link expandVirtualInvalidation}) evaluate fresh, optionally replacing its
 * source. Linked importers keep their instances; pair with `reloadModule()`.
 */
export function invalidateVirtualModule(specifier: string, source?: string): boolean {
  for (const registration of _hooksRegistrations) {
    if (!Object.hasOwn(registration.virtual, specifier)) {
      continue;
    }
    const { virtual, versions, transformSource } = registration;
    if (source !== undefined) {
      virtual[specifier] = transformSource ? transformSource(specifier, source) : source;
    }
    for (const key of expandVirtualInvalidation(virtual, specifier)) {
      versions.set(key, (versions.get(key) ?? 0) + 1);
    }
    return true;
  }
  if (_bunVirtual && Object.hasOwn(_bunVirtual, specifier)) {
    if (source !== undefined) {
      _bunVirtual[specifier] = source;
    }
    _registerBunModules(expandVirtualInvalidation(_bunVirtual, specifier));
    return true;
  }
  return false;
}

/** Handle an `invalidate-module` IPC message and ack with `module-invalidated`. */
export function handleInvalidateModule(
  message: { specifier: string; source?: string },
  sendMessage: (message: unknown) => void,
): void {
  const ok = invalidateVirtualModule(message.specifier, message.source);
  sendMessage({
    event: "module-invalidated",
    specifier: message.specifier,
    error: ok
      ? undefined
      : `Cannot invalidate "${message.specifier}" (not a registered virtual module)`,
  });
}

interface HooksRegistration {
  virtual: Record<string, string>;
  versions: Map<string, number>;
  transformSource?: (specifier: string, source: string) => string;
}

// Live registerHooks registrations, latest first. Registrations stack, so
// invalidation searches all of them (mutating the maps the hooks close over).
const _hooksRegistrations: HooksRegistration[] = [];

let _bunVirtual: Record<string, string> | undefined;

// Read the live map so unregistering (detaching it) disables fresh loads;
// Bun can't remove a `build.module` registration.
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
          const format = virtualModuleFormat(specifier);
          if (format === "json") {
            // Bun's runtime `json` loader doesn't parse contents.
            return { exports: { default: JSON.parse(source) }, loader: "object" };
          }
          return { contents: source, loader: format === "module-typescript" ? "ts" : "js" };
        });
      }
    },
  });
}

// Deno parses every hook-loaded source as JS regardless of `format`. It skips
// import attribute checks there, so `with { type: "json" }` still works.
// `stripTypeScriptTypes` needs Deno >= 2.8.2.
function _transformSourceForDeno(
  specifier: string,
  source: string,
  stripTypeScriptTypes?: (code: string) => string,
): string {
  const format = virtualModuleFormat(specifier);
  if (format === "module-typescript") {
    return stripVirtualTypeScript(specifier, source, stripTypeScriptTypes, {
      requirement: "(custom load hooks bypass Deno's native type stripping)",
      remedy: "upgrade Deno",
    });
  }
  if (format === "json") {
    return `export default JSON.parse(${JSON.stringify(source)});`;
  }
  return source;
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
