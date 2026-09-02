/**
 * Build the environment for a worker thread or child process, inheriting the
 * host env and adding the host's terminal capabilities.
 *
 * A worker's `stdout` is a pipe to the host, never the host TTY, so
 * `process.stdout.isTTY` and `process.stdout.columns` are `undefined` inside
 * it. Output still reaches the terminal, but the standard detection everyone
 * uses reports "not a terminal", stripping ANSI colors and leaving width-aware
 * output unable to size itself (#37).
 *
 * Propagating `FORCE_COLOR` and `COLUMNS` — as `tinypool`, `execa` and `npm`
 * do — lets worker-side code keep using the usual `NO_COLOR` / `FORCE_COLOR` /
 * `isTTY` cascade. Both are only set when the host env has no opinion, so
 * `NO_COLOR` and an explicit `FORCE_COLOR`/`COLUMNS` are always respected.
 *
 * `COLUMNS` is a snapshot taken at spawn time; a later terminal resize is not
 * propagated.
 */
export function hostEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };

  const stdout = process.stdout;
  if (!("FORCE_COLOR" in env) && !env.NO_COLOR && stdout?.isTTY) {
    env.FORCE_COLOR = "1";
  }
  if (!("COLUMNS" in env) && stdout?.columns) {
    env.COLUMNS = String(stdout.columns);
  }

  return env;
}
