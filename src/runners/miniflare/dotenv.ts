import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Dev var loading for the built-in wrangler config reader (no `wrangler`
// package): wrangler's `getVarsForDev` with a `dotenv-expand` port.

/** Expand `$VAR` / `${VAR}` / `${VAR:-default}` references (same rules as `dotenv-expand`). */
export function expandDotenv(
  parsed: Record<string, string>,
  processEnv: Record<string, string>,
): Record<string, string> {
  const running: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    const value =
      processEnv[key] && processEnv[key] !== raw
        ? processEnv[key]
        : expandDotenvValue(raw, processEnv, running);
    running[key] = processEnv[key] = value.replace(/\\\$/g, "$");
  }
  return processEnv;
}

function expandDotenvValue(
  value: string,
  processEnv: Record<string, string>,
  running: Record<string, string>,
): string {
  const env = { ...running, ...processEnv };
  const regex = /(?<!\\)\$\{([^{}]+)\}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const seen = new Set<string>();
  let result = value;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(result)) !== null) {
    seen.add(result);
    const [template, braced, unbraced] = match;
    const expression = (braced || unbraced)!;
    const splitter = expression.match(/(:\+|\+|:-|-)/)?.[0];
    const parts = splitter ? expression.split(splitter) : [expression];
    const key = parts.shift()!;
    let replacement: string;
    if (splitter === ":+" || splitter === "+") {
      replacement = env[key] ? parts.join(splitter) : "";
    } else {
      const found = env[key];
      replacement = found && !seen.has(found) ? found : parts.join(splitter ?? "");
    }
    result = result.replace(template, replacement);
    if (result === running[key]) {
      break;
    }
    regex.lastIndex = 0;
  }
  return result;
}

function readDotenvFile(path: string): Record<string, string> | undefined {
  return existsSync(path)
    ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>)
    : undefined;
}

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "true" ? true : value === "false" ? false : defaultValue;
}

/** Options for {@link loadDevVars}. */
export interface LoadDevVarsOptions {
  /** Directory dev var files resolve against (the config file's dir, else cwd). */
  configDir: string;
  /** Selected wrangler environment (`.dev.vars.<env>`, `.env.<env>`). */
  env?: string;
  /** Custom `.env` files (see `MiniflareEnvRunnerOptions.wranglerEnvFiles`). */
  envFiles?: string[];
  /** Whether the config declares `secrets` (always includes `process.env`). */
  hasSecrets?: boolean;
}

/**
 * Local dev vars like wrangler's `getVarsForDev`: `.dev.vars[.<env>]` (unless
 * `envFiles` is non-empty), else `.env`, `.env.local`, `.env.<env>[.local]`
 * (or `envFiles`), later files winning. `undefined` when nothing was read.
 */
export function loadDevVars(opts: LoadDevVarsOptions): Record<string, string> | undefined {
  const { configDir, env, envFiles } = opts;
  if (!envFiles?.length) {
    const devVars = resolve(configDir, ".dev.vars");
    const loaded =
      (env !== undefined && readDotenvFile(`${devVars}.${env}`)) || readDotenvFile(devVars);
    if (loaded) {
      return loaded;
    }
  }
  if (!booleanEnv("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", true)) {
    return undefined;
  }
  const files = envFiles ?? [
    ".env",
    ".env.local",
    ...(env ? [`.env.${env}`, `.env.${env}.local`] : []),
  ];
  const parsed: Record<string, string> = {};
  for (const file of files) {
    Object.assign(parsed, readDotenvFile(resolve(configDir, file)));
  }
  const processEnv: Record<string, string> = {};
  if (opts.hasSecrets || booleanEnv("CLOUDFLARE_INCLUDE_PROCESS_ENV", false)) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") processEnv[key] = value;
    }
  }
  return expandDotenv(parsed, processEnv);
}
