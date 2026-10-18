import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning a fresh runtime (Deno/Bun child processes, miniflare/workerd) or
    // loading the optional `wrangler` package is a cold start that can exceed
    // Vitest's 5s default on a loaded CI runner. Give every test/hook a generous
    // budget so these first-start costs don't flake.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The built package runs natively, so a `dist` self runner imports its
    // entry through Node's loader (and the virtual module hooks it registers).
    server: { deps: { external: [/\/dist\//] } },
    // Installs Deno's npm packages once before suites spawn Deno workers.
    globalSetup: ["./test/global-setup.ts"],
  },
});
