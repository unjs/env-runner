import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

// Simulate `wrangler` not being installed: importing it rejects, forcing the
// runner onto its built-in minimal JSON/JSONC config reader.
vi.mock("wrangler", () => {
  throw new Error("Cannot find package 'wrangler'");
});

const _dir = dirname(fileURLToPath(import.meta.url));

const ENV_ENTRY = `export default {
  fetch(request, env) {
    return Response.json({ greeting: env.GREETING ?? null, tier: env.TIER ?? null });
  },
};`;

describe("MiniflareEnvRunner (wrangler fallback reader)", () => {
  let runner: EnvRunner | undefined;
  let tmpDir: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    warn.mockRestore();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("reads vars from a plain JSON config and warns about the missing wrangler dep", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-fb-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.json");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-minimal", TIER: "base" },
      }),
    );

    runner = new MiniflareEnvRunner({
      name: "test-fallback-json",
      data: { entry: entryPath },
      wrangler: configPath,
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toEqual({ greeting: "from-minimal", tier: "base" });

    const warnings = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((m: string) => m.includes("'wrangler' is not installed"))).toBe(true);
  });

  it("skips a JSONC config (needs wrangler) and warns", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-fb-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.jsonc");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      `{ /* comment */ "name": "test", "vars": { "GREETING": "from-jsonc" } }`,
    );

    runner = new MiniflareEnvRunner({
      name: "test-fallback-jsonc",
      data: { entry: entryPath },
      wrangler: configPath,
      // JSONC is skipped by the minimal reader, so pin a supported date here.
      miniflareOptions: { compatibilityDate: "2024-09-01" },
    });
    await waitForReady(runner);

    // JSONC was skipped — no binding reached the worker.
    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).greeting).toBeNull();

    const warnings = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((m: string) => m.includes("supports plain JSON only"))).toBe(true);
  });

  it("maps an inline config object without wrangler installed", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-fb-"));
    const entryPath = join(tmpDir, "worker.mjs");
    writeFileSync(entryPath, ENV_ENTRY);

    runner = new MiniflareEnvRunner({
      name: "test-fallback-inline",
      data: { entry: entryPath },
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "inline-minimal" },
      },
    });
    await waitForReady(runner);

    // The minimal mapper accepts the raw object directly (the one-time
    // "not installed" warning is asserted by the JSONC test above).
    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).greeting).toBe("inline-minimal");
  });

  it("skips a TOML config (needs wrangler) and warns", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-fb-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const configPath = join(tmpDir, "wrangler.toml");
    writeFileSync(entryPath, ENV_ENTRY);
    writeFileSync(
      configPath,
      `name = "test"\ncompatibility_date = "2024-09-01"\n[vars]\nGREETING = "from-toml"\n`,
    );

    runner = new MiniflareEnvRunner({
      name: "test-fallback-toml",
      data: { entry: entryPath },
      wrangler: configPath,
      // TOML is skipped by the fallback reader, so pin a supported date here.
      miniflareOptions: { compatibilityDate: "2024-09-01" },
    });
    await waitForReady(runner);

    // TOML was skipped — no binding reached the worker.
    const res = await runner.fetch("http://localhost/");
    expect((await res.json()).greeting).toBeNull();

    const warnings = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnings.some((m: string) => m.includes("supports plain JSON only"))).toBe(true);
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
