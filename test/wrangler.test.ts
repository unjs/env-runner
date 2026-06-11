import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { MiniflareEnvRunnerOptions } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

// The runner class under test. The installed-path tests use the real `wrangler`
// package (statically imported below). The fallback describe simulates wrangler
// not being installed: it `vi.doMock`s `import("wrangler")` to throw, then
// re-imports `runner.ts` after `vi.resetModules()` so the freshly-loaded
// module's lazy `import("wrangler")` resolves onto the throwing mock and the
// runner falls back to its built-in minimal reader.
let Runner: typeof MiniflareEnvRunner = MiniflareEnvRunner;

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

// Entry that reports whether the KV binding arrived as a real KVNamespace.
const KV_ENTRY = `export default {
  fetch(request, env) {
    return Response.json({ kv: typeof env.MY_KV?.get });
  },
};`;

interface WranglerCase {
  name: string;
  /** Entry source (defaults to `ENV_ENTRY`). */
  entry?: string;
  /** Files to write into the temp dir (filename → contents). */
  files?: Record<string, string>;
  /** Extra runner options (e.g. `wrangler`, `wranglerEnv`, `miniflareOptions`). */
  options: (ctx: { tmpDir: string; entryPath: string }) => Partial<MiniflareEnvRunnerOptions>;
  /** Assert on the JSON the worker returned. */
  assert: (json: any) => void;
  /** Substrings expected among `console.warn` messages (fallback path only). */
  warns?: string[];
}

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

// Set up a temp dir + entry (+ optional config files), construct the runner,
// wait for readiness, and return the worker's JSON response.
async function runWranglerCase(c: WranglerCase): Promise<any> {
  tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
  const entryPath = join(tmpDir, "worker.mjs");
  writeFileSync(entryPath, c.entry ?? ENV_ENTRY);
  for (const [filename, contents] of Object.entries(c.files ?? {})) {
    writeFileSync(join(tmpDir, filename), contents);
  }

  runner = new Runner({
    name: c.name,
    data: { entry: entryPath },
    ...c.options({ tmpDir, entryPath }),
  });
  await waitForReady(runner);

  const res = await runner.fetch("http://localhost/");
  return res.json();
}

// --- Installed `wrangler` package (full fidelity) ---

const INSTALLED_CASES: WranglerCase[] = [
  {
    name: "loads vars from a wrangler.jsonc config (explicit path)",
    files: {
      "wrangler.jsonc": `{
        // wrangler config with vars
        "name": "test",
        "compatibility_date": "2024-09-01",
        "vars": { "GREETING": "from-wrangler", "TIER": "base" },
      }`,
    },
    options: ({ tmpDir }) => ({ wrangler: join(tmpDir, "wrangler.jsonc") }),
    assert: (json) => expect(json).toEqual({ greeting: "from-wrangler", tier: "base" }),
  },
  {
    name: "auto-discovers wrangler config next to the entry (wrangler: true)",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "auto-found" },
      }),
    },
    options: () => ({ wrangler: true }),
    assert: (json) => expect(json.greeting).toBe("auto-found"),
  },
  {
    name: "applies the selected --env via wranglerEnv",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { TIER: "base" },
        env: { production: { vars: { TIER: "prod" } } },
      }),
    },
    options: ({ tmpDir }) => ({
      wrangler: join(tmpDir, "wrangler.json"),
      wranglerEnv: "production",
    }),
    assert: (json) => expect(json.tier).toBe("prod"),
  },
  {
    name: "loads bindings from an inline wrangler config object",
    options: () => ({
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-inline", TIER: "base" },
      },
    }),
    assert: (json) => expect(json).toEqual({ greeting: "from-inline", tier: "base" }),
  },
  {
    name: "applies --env to an inline wrangler config",
    options: () => ({
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        env: { production: { vars: { TIER: "prod" } } },
      },
      wranglerEnv: "production",
    }),
    assert: (json) => expect(json.tier).toBe("prod"),
  },
  {
    name: "merges an inline config on top of an auto-discovered config file",
    // File supplies both vars; the inline config overrides only GREETING.
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-file", TIER: "from-file" },
      }),
    },
    options: () => ({ wrangler: { vars: { GREETING: "from-inline" } } }),
    // GREETING from inline (wins), TIER preserved from the discovered file.
    assert: (json) => expect(json).toEqual({ greeting: "from-inline", tier: "from-file" }),
  },
  {
    name: "lets miniflareOptions bindings merge with (and win over) wrangler vars",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-wrangler", TIER: "from-wrangler" },
      }),
    },
    options: ({ tmpDir }) => ({
      wrangler: join(tmpDir, "wrangler.json"),
      miniflareOptions: { bindings: { GREETING: "from-options" } },
    }),
    // GREETING overridden by miniflareOptions; TIER preserved from wrangler
    // (the binding records are merged per key, not replaced wholesale).
    assert: (json) => expect(json).toEqual({ greeting: "from-options", tier: "from-wrangler" }),
  },
];

describe("MiniflareEnvRunner (wrangler config)", () => {
  for (const c of INSTALLED_CASES) {
    it(c.name, async () => {
      const json = await runWranglerCase(c);
      c.assert(json);
    });
  }
});

// --- Built-in minimal reader (wrangler not installed) ---

const FALLBACK_CASES: WranglerCase[] = [
  {
    name: "reads vars from a plain JSON config and warns about the missing wrangler dep",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-minimal", TIER: "base" },
      }),
    },
    options: ({ tmpDir }) => ({ wrangler: join(tmpDir, "wrangler.json") }),
    assert: (json) => expect(json).toEqual({ greeting: "from-minimal", tier: "base" }),
    warns: ["'wrangler' is not installed"],
  },
  {
    name: "skips a JSONC config (needs wrangler) and warns",
    files: {
      "wrangler.jsonc": `{ /* comment */ "name": "test", "vars": { "GREETING": "from-jsonc" } }`,
    },
    // JSONC is skipped by the minimal reader, so pin a supported date here.
    options: ({ tmpDir }) => ({
      wrangler: join(tmpDir, "wrangler.jsonc"),
      miniflareOptions: { compatibilityDate: "2024-09-01" },
    }),
    // JSONC was skipped — no binding reached the worker.
    assert: (json) => expect(json.greeting).toBeNull(),
    warns: ["supports plain JSON only"],
  },
  {
    name: "maps an inline config object without wrangler installed",
    options: () => ({
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "inline-minimal" },
      },
    }),
    assert: (json) => expect(json.greeting).toBe("inline-minimal"),
  },
  {
    name: "maps non-var bindings (kv_namespaces) via the minimal mapper",
    entry: KV_ENTRY,
    options: () => ({
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        kv_namespaces: [{ binding: "MY_KV", id: "kv-id" }],
      },
    }),
    // The KV binding reached the worker as a real KVNamespace (has `.get`).
    assert: (json) => expect(json.kv).toBe("function"),
  },
  {
    name: "skips a TOML config (needs wrangler) and warns",
    files: {
      "wrangler.toml": `name = "test"\ncompatibility_date = "2024-09-01"\n[vars]\nGREETING = "from-toml"\n`,
    },
    // TOML is skipped by the fallback reader, so pin a supported date here.
    options: ({ tmpDir }) => ({
      wrangler: join(tmpDir, "wrangler.toml"),
      miniflareOptions: { compatibilityDate: "2024-09-01" },
    }),
    // TOML was skipped — no binding reached the worker.
    assert: (json) => expect(json.greeting).toBeNull(),
    warns: ["supports plain JSON only"],
  },
];

describe("MiniflareEnvRunner (wrangler config, fallback reader)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Make `import("wrangler")` throw, drop the module cache, and re-import
    // `runner.ts` so its lazy `import("wrangler")` re-resolves onto the
    // throwing mock (and thus the built-in minimal reader).
    vi.doMock("wrangler", () => {
      throw new Error("Cannot find package 'wrangler'");
    });
    vi.resetModules();
    Runner = (await import("../src/runners/miniflare/runner.ts")).MiniflareEnvRunner;
  });

  afterAll(() => {
    vi.doUnmock("wrangler");
    vi.resetModules();
    Runner = MiniflareEnvRunner;
  });

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  for (const c of FALLBACK_CASES) {
    it(c.name, async () => {
      const json = await runWranglerCase(c);
      c.assert(json);
      if (c.warns) {
        const warnings = warn.mock.calls.map((call: unknown[]) => String(call[0]));
        for (const expected of c.warns) {
          expect(warnings.some((m: string) => m.includes(expected))).toBe(true);
        }
      }
    });
  }
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
