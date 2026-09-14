import { resolveModulePath } from "exsolve";
import { pathToFileURL } from "node:url";

/**
 * An app-owned package: the imported module, a specifier (resolved from the
 * app, not `env-runner`), or `false` to opt out. Omitted falls back to an
 * optional `import()`.
 */
export type RuntimeDep<T> = T | string | URL | false;

export interface ResolveRuntimeDepOptions<T> {
  /** Package name, used for the fallback import and in messages. */
  name: string;
  /** Constructor/function option name, used in messages. */
  option: string;
  /** Value as passed by the caller. */
  value?: RuntimeDep<T>;
  /** Named export identifying the package (a mismatch throws for an explicit value). */
  expect?: string;
  /** Directory bare specifiers resolve from. @default process.cwd() */
  from?: string;
  /** Throw when unresolvable instead of resolving `undefined` (callers degrade). */
  required?: boolean;
  /** Extra sentence appended to the "not installed" error when `required`. */
  hint?: string;
}

/** Whether a value is a module specifier rather than an imported module. */
function isSpecifier(value: unknown): value is string | URL {
  return typeof value === "string" || value instanceof URL;
}

/**
 * Resolve a bare specifier from the app rather than `env-runner`. Unresolvable
 * specifiers pass through so `import()` reports the error.
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
 * Resolve a {@link RuntimeDep} to a module. An explicit specifier that fails to
 * import throws; an omitted one resolves `undefined` unless `required`.
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

/** Narrow a {@link RuntimeDep} to a specifier, for packages imported inside the worker. */
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
