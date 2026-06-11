import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));

// Entry that echoes selected bindings from `env` as JSON.
const ENV_ENTRY = `export default {
  fetch(request, env) {
    return Response.json({
      greeting: env.GREETING ?? null,
      tier: env.TIER ?? null,
    });
  },
};`;

describe("MiniflareEnvRunner (wrangler config)", () => {
  let runner: EnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("loads vars from a wrangler.jsonc config (explicit path)", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.jsonc");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      `{
        // wrangler config with vars
        "name": "test",
        "compatibility_date": "2024-09-01",
        "vars": { "GREETING": "from-wrangler", "TIER": "base" },
      }`,
    );

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-vars",
      data: { entry: entryPath },
      wrangler: configPath,
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toEqual({ greeting: "from-wrangler", tier: "base" });
  });

  it("auto-discovers wrangler config next to the entry (wrangler: true)", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      join(tmpDir, "wrangler.json"),
      JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "auto-found" },
      }),
    );

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-auto",
      data: { entry: entryPath },
      wrangler: true,
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).greeting).toBe("auto-found");
  });

  it("applies the selected --env via wranglerEnv", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.json");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { TIER: "base" },
        env: { production: { vars: { TIER: "prod" } } },
      }),
    );

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-env",
      data: { entry: entryPath },
      wrangler: configPath,
      wranglerEnv: "production",
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).tier).toBe("prod");
  });

  it("loads bindings from an inline wrangler config object", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    writeFileSync(entryPath, ENV_ENTRY);

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-inline",
      data: { entry: entryPath },
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-inline", TIER: "base" },
      },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toEqual({ greeting: "from-inline", tier: "base" });
  });

  it("applies --env to an inline wrangler config", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    writeFileSync(entryPath, ENV_ENTRY);

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-inline-env",
      data: { entry: entryPath },
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        env: { production: { vars: { TIER: "prod" } } },
      },
      wranglerEnv: "production",
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).tier).toBe("prod");
  });

  it("lets miniflareOptions bindings win over wrangler vars", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.json");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-wrangler" },
      }),
    );

    runner = new MiniflareEnvRunner({
      name: "test-wrangler-precedence",
      data: { entry: entryPath },
      wrangler: configPath,
      miniflareOptions: { bindings: { GREETING: "from-options" } },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).greeting).toBe("from-options");
  });
});

// --- Helpers ---

function waitForReady(runner: EnvRunner, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (runner.ready) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Runner did not become ready")), timeout);
    runner.onMessage(() => {
      if (runner.ready) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
