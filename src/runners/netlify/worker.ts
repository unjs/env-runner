import { workerData } from "node:worker_threads";
import { resolveRuntimeDep } from "../../common/runtime-deps.ts";

const netlifyEnv = {
  get: (key: string) => process.env[key],
  has: (key: string) => key in process.env,
  set: (key: string, value: string) => {
    process.env[key] = value;
  },
  delete: (key: string) => {
    delete process.env[key];
  },
  toObject: () => ({ ...process.env }) as Record<string, string>,
};

// `@netlify/runtime` is not a dependency of env-runner. The runner forwards the
// specifier the app resolved (see `NetlifyEnvRunner`'s `netlifyRuntime`
// option); without one, fall back to importing the package optionally, and to
// a lightweight `globalThis.Netlify` shim when neither is available. `false`
// forces the shim.
const runtimeSpecifier = (workerData || {}).netlifyRuntime as string | false | undefined;

let started = false;
if (runtimeSpecifier !== false) {
  try {
    const runtime = await resolveRuntimeDep<{ startRuntime: (options: unknown) => void }>({
      name: "@netlify/runtime",
      option: "netlifyRuntime",
      value: runtimeSpecifier,
      expect: "startRuntime",
    });
    const startRuntime = runtime?.startRuntime;
    if (!startRuntime) {
      throw new Error("`@netlify/runtime` is not installed");
    }
    startRuntime({
      deployID: "0",
      siteID: "0",
      env: netlifyEnv,
      getRequestContext: () => null,
      cache: { getCacheAPIContext: () => null },
    });
    started = true;
  } catch (error: any) {
    // Only an explicit specifier is worth warning about — a missing optional
    // package is the expected path into the shim.
    if (runtimeSpecifier) {
      console.warn(
        `[env-runner] failed to start the Netlify runtime from "${runtimeSpecifier}": ${error?.cause?.message || error?.message || error}`,
      );
    }
  }
}

if (!started) {
  (globalThis as any).Netlify = { context: null, env: netlifyEnv };
}

await import("../node-worker/worker.ts");
