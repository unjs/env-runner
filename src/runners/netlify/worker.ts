try {
  const { startRuntime } = await import("@netlify/runtime");
  startRuntime({
    deployID: "0",
    siteID: "0",
    env: {
      get: (key: string) => process.env[key],
      has: (key: string) => key in process.env,
      set: (key: string, value: string) => {
        process.env[key] = value;
      },
      delete: (key: string) => {
        delete process.env[key];
      },
      toObject: () => ({ ...process.env }) as Record<string, string>,
    },
    getRequestContext: () => null,
    cache: { getCacheAPIContext: () => null },
  });
} catch {
  if (!process.env.__ENV_RUNNER_NETLIFY_WARNED) {
    process.env.__ENV_RUNNER_NETLIFY_WARNED = "1";
    console.warn(
      "@netlify/runtime is not installed. Install it for full Netlify runtime emulation: npx nypm i -D @netlify/runtime",
    );
  }
  (globalThis as any).Netlify = {
    context: null,
    env: {
      get: (key: string) => process.env[key],
      has: (key: string) => key in process.env,
      set: (key: string, value: string) => {
        process.env[key] = value;
      },
      delete: (key: string) => {
        delete process.env[key];
      },
      toObject: () => ({ ...process.env }) as Record<string, string>,
    },
  };
}

await import("../node-worker/worker.ts");
