import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning a fresh runtime (Deno/Bun child processes, miniflare/workerd) or
    // loading the optional `wrangler` package is a cold start that can exceed
    // Vitest's 5s default on a loaded CI runner. Give every test/hook a generous
    // budget so these first-start costs don't flake.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
