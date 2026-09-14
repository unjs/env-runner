/**
 * Worker/child env with the host TTY's color and width: worker stdout is a
 * pipe, so `isTTY`/`columns` detection fails inside it. `COLUMNS` is a
 * spawn-time snapshot (resizes aren't propagated).
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
