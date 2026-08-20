import { resolveModulePath } from "exsolve";
import { pathToFileURL } from "node:url";

/**
 * A runtime dependency the application owns, not `env-runner`.
 *
 * Every runner option that names an external package accepts the same three
 * shapes, so the choice is about ergonomics rather than per-runner API:
 *
 * - the **imported module** (`import * as miniflare from "miniflare"`) — the
 *   version installed by the app is the version that runs
 * - a **module specifier** (`"miniflare"`, `import.meta.resolve("miniflare")`,
 *   or a `URL`) — resolved from {@link ResolveRuntimeDepOptions.from} (cwd by
 *   default), so a bare specifier resolves against the app rather than against
 *   `env-runner`'s own `node_modules`
 * - `false` — opt out of the package entirely
 *
 * Omitting the option falls back to an optional `import()` of the package.
 */
export type RuntimeDep<T> = T | string | URL | false;

export interface ResolveRuntimeDepOptions<T> {
  /** Package name, used for the fallback import and in messages. */
  name: string;
  /** Constructor/function option name, used in messages. */
  option: string;
  /** Value as passed by the caller. */
  value?: RuntimeDep<T>;
  /**
   * Named export the resolved module must expose. A module that lacks it is
   * treated as the wrong package (throws for an explicit value).
   */
  expect?: string;
  /** Directory bare specifiers resolve from. @default process.cwd() */
  from?: string;
  /**
   * Throw when the package cannot be resolved at all. Otherwise an
   * unavailable optional package resolves to `undefined` and the caller
   * degrades (minimal reader, shim, no-op).
   */
  required?: boolean;
  /** Extra sentence appended to the "not installed" error when `required`. */
  hint?: string;
}

/** Whether a value is a module specifier rather than an imported module. */
function isSpecifier(value: unknown): value is string | URL {
  return typeof value === "string" || value instanceof URL;
}

/**
 * Turn a specifier into something `import()` can load from the app's
 * `node_modules` rather than from `env-runner`'s own location. Absolute paths
 * and URLs pass through; a bare specifier that cannot be resolved is handed to
 * `import()` as-is so the error comes from the runtime.
 */
export function resolveSpecifier(value: string | URL, from: string = process.cwd()): string {
  if (value instanceof URL) {
    return value.href;
  }
  if (value.includes("://")) {
    return value;
  }
  const resolved = resolveModulePath(value, {
    from: from.endsWith("/") ? from : from + "/",
    try: true,
  });
  return resolved ? pathToFileURL(resolved).href : value;
}

/**
 * Resolve a {@link RuntimeDep} to an imported module.
 *
 * Resolution order: `false` → `undefined`; an imported module → validated and
 * returned as-is; a specifier → imported (errors propagate, since an explicit
 * specifier that cannot load is a mistake worth surfacing); omitted → optional
 * `import(name)`, which yields `undefined` when the package isn't installed
 * unless {@link ResolveRuntimeDepOptions.required} is set.
 */
export async function resolveRuntimeDep<T>(
  opts: ResolveRuntimeDepOptions<T>,
): Promise<T | undefined> {
  const { name, option, value, expect, from, required, hint } = opts;

  if (value === false) {
    return undefined;
  }

  if (value !== undefined) {
    if (!isSpecifier(value)) {
      return validate(value as T, expect, name, option);
    }
    const raw = typeof value === "string" ? value : value.href;
    let mod: unknown;
    try {
      mod = await import(resolveSpecifier(value, from));
    } catch (error) {
      throw new TypeError(
        `[env-runner] failed to import \`${name}\` from the \`${option}\` specifier "${raw}".`,
        { cause: error },
      );
    }
    return validate(mod as T, expect, name, option);
  }

  try {
    const mod = await import(resolveSpecifier(name, from));
    return validate(mod as T, expect, name, option);
  } catch (error) {
    if (required) {
      throw new TypeError(
        `[env-runner] the \`${name}\` package is required: install it, or pass it as the ` +
          `\`${option}\` option (the imported module or a specifier).` +
          (hint ? ` ${hint}` : ""),
        { cause: error },
      );
    }
    return undefined;
  }
}

function validate<T>(mod: T, expect: string | undefined, name: string, option: string): T {
  if (expect && typeof (mod as Record<string, unknown>)?.[expect] !== "function") {
    throw new TypeError(
      `[env-runner] the \`${option}\` option does not export \`${expect}\` — ` +
        `pass the imported \`${name}\` package or a specifier for it.`,
    );
  }
  return mod;
}

/**
 * Narrow a {@link RuntimeDep} to a specifier that can cross a worker/process
 * boundary. Used by options whose package must be imported *inside* the
 * worker, where a live module instance cannot be handed over.
 */
export function resolveRuntimeDepSpecifier<T>(
  value: RuntimeDep<T> | undefined,
  option: string,
  from?: string,
): string | false | undefined {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return undefined;
  }
  if (!isSpecifier(value)) {
    throw new TypeError(
      `[env-runner] the \`${option}\` option must be a module specifier (string or URL): ` +
        `the package is imported inside the worker, so an imported module cannot be passed. ` +
        `Use \`import.meta.resolve()\`.`,
    );
  }
  return resolveSpecifier(value, from);
}
