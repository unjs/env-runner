import type { WorkerHooks, EnvRunner } from "./types.ts";
import type { EnvRunnerData } from "./common/base-runner.ts";

export type RunnerName =
  | "node-worker"
  | "node-process"
  | "bun-process"
  | "deno-process"
  | "self"
  | "miniflare";

export interface LoadRunnerOptions {
  name: string;
  workerEntry?: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  execArgv?: string[];
  /** Additional runner-specific options (passed through to the runner constructor). */
  [key: string]: unknown;
}

type RunnerConstructor = new (opts: LoadRunnerOptions) => EnvRunner;

const loaders: Record<RunnerName, () => Promise<RunnerConstructor>> = {
  "node-worker": () => import("env-runner/runners/node-worker").then((m) => m.NodeWorkerEnvRunner),
  "node-process": () =>
    import("env-runner/runners/node-process").then((m) => m.NodeProcessEnvRunner),
  "bun-process": () => import("env-runner/runners/bun-process").then((m) => m.BunProcessEnvRunner),
  "deno-process": () =>
    import("env-runner/runners/deno-process").then((m) => m.DenoProcessEnvRunner),
  self: () => import("env-runner/runners/self").then((m) => m.SelfEnvRunner),
  miniflare: () => import("env-runner/runners/miniflare").then((m) => m.MiniflareEnvRunner),
};

export async function loadRunner(runner: RunnerName, opts: LoadRunnerOptions): Promise<EnvRunner> {
  const RunnerClass = await loaders[runner]();
  return new RunnerClass(opts);
}
