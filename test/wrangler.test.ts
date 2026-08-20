import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as miniflare from "miniflare";
import * as wrangler from "wrangler";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { MiniflareEnvRunnerOptions } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

// `wranglerModule` is an explicit runner option, so the two paths need no
// module mocking: the installed-path cases pass the real `wrangler` package,
// the fallback cases pass `false` to skip it (an omitted option would fall
// back to `import("wrangler")`, which resolves here) and exercise the
// built-in minimal reader.

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
  /** Pass the real `wrangler` package (full fidelity) instead of the minimal reader. */
  withWrangler?: boolean;
  /** Pass `wrangler` as a module specifier instead of an imported module. */
  wranglerSpecifier?: string;
  /** Assert on the JSON the worker returned. */
  assert: (json: any) => void;
  /** Substrings expected among `console.warn` messages (fallback path only). */
  warns?: string[];
}

// Loading the real `wrangler` package (+ spinning up miniflare/workerd) on the
// first installed-case test is a heavy cold start that can exceed Vitest's 5s
// default. Give the wrangler suites a generous per-test budget (and a matching
// readiness wait) so the cold start doesn't flake.
const WRANGLER_TEST_TIMEOUT = 30_000;

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

  runner = new MiniflareEnvRunner({
    name: c.name,
    miniflare,
    data: { entry: entryPath },
    wranglerModule: c.wranglerSpecifier ?? (c.withWrangler ? wrangler : false),
    ...c.options({ tmpDir, entryPath }),
  });
  await waitForReady(runner, WRANGLER_TEST_TIMEOUT);

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
    name: "accepts a module specifier for `wranglerModule`",
    wranglerSpecifier: "wrangler",
    files: {
      "wrangler.jsonc": `{
        // only the real wrangler package can parse JSONC
        "name": "test",
        "compatibility_date": "2024-09-01",
        "vars": { "GREETING": "from-specifier" },
      }`,
    },
    options: ({ tmpDir }) => ({ wrangler: join(tmpDir, "wrangler.jsonc") }),
    assert: (json) => expect(json.greeting).toBe("from-specifier"),
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
    // `transformRequest` (Vite-style TS compilation) and a `wrangler` config are
    // the headline combination this feature targets, so verify they coexist: a
    // TS helper is transformed on the fly while bindings come from wrangler.
    // (Also guards the denylist: wrangler's `unstable_getMiniflareWorkerOptions`
    // always returns default `modulesRules`, which the runner must not adopt.)
    name: "supports transformRequest alongside a wrangler config",
    files: {
      "helper.ts": `const msg: string = "transformed"; export default msg;`,
    },
    entry: `import msg from "./helper.ts";
export default {
  fetch(request, env) {
    return Response.json({ greeting: env.GREETING ?? null, tier: msg });
  },
};`,
    options: () => ({
      wrangler: {
        name: "inline",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-wrangler" },
      },
      transformRequest: async (id: string) => {
        if (!id.endsWith(".ts")) return null;
        const { readFileSync } = await import("node:fs");
        return { code: readFileSync(id, "utf8").replace(/:\s*string/g, "") };
      },
    }),
    assert: (json) => expect(json).toEqual({ greeting: "from-wrangler", tier: "transformed" }),
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
    it(
      c.name,
      async () => {
        const json = await runWranglerCase({ ...c, withWrangler: true });
        c.assert(json);
      },
      WRANGLER_TEST_TIMEOUT,
    );
  }

  it(
    "defaults wranglerEnv to the CLOUDFLARE_ENV variable",
    async () => {
      vi.stubEnv("CLOUDFLARE_ENV", "production");
      try {
        const json = await runWranglerCase({
          name: "cloudflare-env",
          files: {
            "wrangler.json": JSON.stringify({
              name: "test",
              compatibility_date: "2024-09-01",
              vars: { TIER: "base" },
              env: { production: { vars: { TIER: "prod" } } },
            }),
          },
          // No `wranglerEnv` — it should fall back to CLOUDFLARE_ENV.
          options: () => ({ wrangler: true }),
          assert: (json) => expect(json.tier).toBe("prod"),
          withWrangler: true,
        });
        expect(json.tier).toBe("prod");
      } finally {
        vi.unstubAllEnvs();
      }
    },
    WRANGLER_TEST_TIMEOUT,
  );
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

function waitForReady(runner: EnvRunner, timeout = 15000): Promise<void> {
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
