import { execFileSync } from "node:child_process";

/** Returns true when the given runtime binary is available on PATH. */
export function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const hasBun = hasRuntime("bun");
export const hasDeno = hasRuntime("deno");
