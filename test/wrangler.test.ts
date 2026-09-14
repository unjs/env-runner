import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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

// Entry that writes to KV (to observe on-disk persistence).
const KV_PUT_ENTRY = `export default {
  async fetch(request, env) {
    await env.MY_KV.put("key", "value");
    return Response.json({ value: await env.MY_KV.get("key") });
  },
};`;

// Entry exporting two Durable Object classes and reporting which bindings exist.
const DO_ENTRY = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {}
export class Greeter extends DurableObject {}
export default {
  fetch(request, env) {
    return Response.json({
      greeting: env.GREETING ?? null,
      local: typeof env.LOCAL?.idFromName,
      greeter: typeof env.GREETER?.idFromName,
      counter: typeof env.COUNTER,
      external: typeof env.EXTERNAL,
      service: typeof env.OTHER_SERVICE,
      workflow: typeof env.MY_WORKFLOW,
      assets: typeof env.ASSETS,
    });
  },
};`;

interface WranglerCaseContext {
  tmpDir: string;
  entryPath: string;
  /** Options the runner passed to the `Miniflare` constructor. */
  mfOptions: Record<string, any>;
}

interface WranglerCase {
  name: string;
  /** Entry source (defaults to `ENV_ENTRY`). */
  entry?: string;
  /** Files to write into the temp dir (relative path → contents; parent dirs are created). */
  files?: Record<string, string>;
  /** Extra runner options (e.g. `wrangler`, `wranglerEnv`, `miniflareOptions`). */
  options: (ctx: { tmpDir: string; entryPath: string }) => Partial<MiniflareEnvRunnerOptions>;
  /** Pass the real `wrangler` package (full fidelity) instead of the minimal reader. */
  withWrangler?: boolean;
  /** Pass `wrangler` as a module specifier instead of an imported module. */
  wranglerSpecifier?: string;
  /** Assert on the JSON the worker returned (and the resolved Miniflare options). */
  assert: (json: any, ctx: WranglerCaseContext) => void;
  /** Substrings expected among `console.warn` messages. */
  warns?: string[];
  /** Custom assertion on all `console.warn` messages. */
  assertWarnings?: (warnings: string[]) => void;
}

const DROPPED_WARNING = "wrangler config options not supported by the miniflare dev runner";

// The "ignored options" warnings among the captured `console.warn` messages.
function droppedWarnings(warnings: string[]): string[] {
  return warnings.filter((m) => m.includes(DROPPED_WARNING));
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
// wait for readiness, and return the worker's JSON response along with the
// options the runner passed to Miniflare (captured via a subclass).
async function runWranglerCase(c: WranglerCase): Promise<{ json: any; ctx: WranglerCaseContext }> {
  tmpDir = mkdtempSync(join(_dir, ".tmp-wrangler-"));
  const entryPath = join(tmpDir, "worker.mjs");
  writeFileSync(entryPath, c.entry ?? ENV_ENTRY);
  for (const [filename, contents] of Object.entries(c.files ?? {})) {
    const file = join(tmpDir, filename);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  const ctx = { tmpDir, entryPath, mfOptions: {} } as WranglerCaseContext;
  class CapturingMiniflare extends miniflare.Miniflare {
    constructor(options: any) {
      ctx.mfOptions = options;
      // Miniflare creates persist dirs eagerly (e.g. `cache/`). Keep tests
      // from writing state outside the temp dir (cwd-anchored defaults would
      // land in the repo root): assert on the captured options instead.
      const root = options.defaultPersistRoot;
      const inTmp = typeof root !== "string" || root.startsWith(ctx.tmpDir + sep);
      super(inTmp ? options : { ...options, defaultPersistRoot: undefined });
    }
  }

  runner = new MiniflareEnvRunner({
    name: c.name,
    miniflare: { ...miniflare, Miniflare: CapturingMiniflare },
    data: { entry: entryPath },
    wranglerModule: c.wranglerSpecifier ?? (c.withWrangler ? wrangler : false),
    ...c.options({ tmpDir, entryPath }),
  });
  await waitForReady(runner, WRANGLER_TEST_TIMEOUT);

  const res = await runner.fetch("http://localhost/");
  return { json: await res.json(), ctx };
}

// Register one `it` per case, asserting on the response and expected warnings.
function defineWranglerCases(cases: WranglerCase[], withWrangler: boolean): void {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  for (const c of cases) {
    it(
      c.name,
      async () => {
        const { json, ctx } = await runWranglerCase({ withWrangler, ...c });
        c.assert(json, ctx);
        const warnings = warn.mock.calls.map((call: unknown[]) => String(call[0]));
        for (const expected of c.warns ?? []) {
          expect(warnings.some((m: string) => m.includes(expected))).toBe(true);
        }
        c.assertWarnings?.(warnings);
      },
      WRANGLER_TEST_TIMEOUT,
    );
  }
}

// Cases shared by both backends (the minimal reader and the real package).
const SHARED_CASES: WranglerCase[] = [
  {
    name: "merges an inline config on top of an explicit wranglerConfigPath",
    // The config lives outside the entry dir (and cwd), so auto-discovery
    // alone would not find it.
    files: {
      "config/wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-file", TIER: "from-file" },
      }),
    },
    options: ({ tmpDir }) => ({
      wrangler: { vars: { GREETING: "from-inline" } },
      wranglerConfigPath: join(tmpDir, "config/wrangler.json"),
    }),
    assert: (json, ctx) => {
      expect(json).toEqual({ greeting: "from-inline", tier: "from-file" });
      // The inline config's temp normalization dir must not leak as `rootPath`.
      expect(String(ctx.mfOptions.rootPath ?? "")).not.toContain("env-runner-wrangler-");
    },
  },
  {
    name: "uses wranglerConfigPath with `wrangler: true`",
    files: {
      "config/wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-config-path" },
      }),
    },
    options: ({ tmpDir }) => ({
      wrangler: true,
      wranglerConfigPath: join(tmpDir, "config/wrangler.json"),
    }),
    assert: (json) => expect(json.greeting).toBe("from-config-path"),
    // wrangler returns `{}`/`[]` for unused binding types — no drop warning.
    assertWarnings: (warnings) => expect(droppedWarnings(warnings)).toEqual([]),
  },
  {
    name: "keeps file env bindings when an inline env map lacks the selected env",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { TIER: "file-top" },
        env: { test: { vars: { TIER: "file-env" } } },
      }),
    },
    options: () => ({
      wrangler: {
        vars: { GREETING: "inline-top" },
        env: { prod: { vars: { GREETING: "inline-prod" } } },
      },
      wranglerEnv: "test",
    }),
    // File `env.test` applies; the inline config has no `test` env, so its
    // top level is used as-is.
    assert: (json) => expect(json).toEqual({ greeting: "inline-top", tier: "file-env" }),
    assertWarnings: (warnings) =>
      expect(warnings.filter((m) => m.includes("failed to load"))).toEqual([]),
  },
  {
    name: "warns about a missing wranglerConfigPath and continues with the inline config",
    options: ({ tmpDir }) => ({
      wrangler: { compatibility_date: "2024-09-01", vars: { GREETING: "inline-only" } },
      wranglerConfigPath: join(tmpDir, "missing/wrangler.json"),
    }),
    assert: (json) => expect(json.greeting).toBe("inline-only"),
    warns: ["wrangler config requested but not found"],
  },
  {
    name: 'compatibilityDate: "latest" overrides the wrangler date',
    options: () => ({
      wrangler: { compatibility_date: "2024-09-01", vars: { GREETING: "latest" } },
      compatibilityDate: "latest",
    }),
    assert: (json, { mfOptions }) => {
      expect(json.greeting).toBe("latest");
      expect(mfOptions.compatibilityDate).toBe(miniflare.supportedCompatibilityDate);
    },
  },
  {
    name: "miniflareOptions.compatibilityDate wins over compatibilityDate",
    options: () => ({
      wrangler: { compatibility_date: "2024-09-01" },
      compatibilityDate: "latest",
      miniflareOptions: { compatibilityDate: "2024-10-01" },
    }),
    assert: (_json, { mfOptions }) => expect(mfOptions.compatibilityDate).toBe("2024-10-01"),
  },
  {
    name: "clamps a future wrangler compatibility_date to the supported date",
    options: () => ({
      wrangler: { compatibility_date: "2999-01-01", vars: { GREETING: "clamped" } },
    }),
    assert: (json, { mfOptions }) => {
      expect(json.greeting).toBe("clamped");
      expect(mfOptions.compatibilityDate).toBe(miniflare.supportedCompatibilityDate);
    },
    warns: ['compatibility date "2999-01-01" is newer than the installed workerd supports'],
  },
  {
    name: "drops Durable Object bindings to another script and merges auto-wired exports",
    entry: DO_ENTRY,
    options: () => ({
      wrangler: {
        compatibility_date: "2024-09-01",
        vars: { GREETING: "do" },
        durable_objects: {
          bindings: [
            { name: "LOCAL", class_name: "Counter" },
            { name: "EXTERNAL", class_name: "Remote", script_name: "other-worker" },
          ],
        },
        migrations: [{ tag: "v1", new_classes: ["Counter", "Greeter"] }],
      },
    }),
    // LOCAL (wrangler) + GREETER (auto-wired); Counter is already bound, so no
    // COUNTER binding; the external-script binding is dropped.
    assert: (json) =>
      expect(json).toMatchObject({
        greeting: "do",
        local: "function",
        greeter: "function",
        counter: "undefined",
        external: "undefined",
      }),
    assertWarnings: (warnings) => {
      const dropped = droppedWarnings(warnings);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain('durable_objects (EXTERNAL → script "other-worker")');
      expect(dropped[0]).not.toContain("LOCAL");
    },
  },
  {
    name: "drops services, assets, queue consumers, workflows and tails from the config",
    entry: DO_ENTRY,
    files: {
      "public/index.html": "<h1>hi</h1>",
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "still-serves" },
        services: [{ binding: "OTHER_SERVICE", service: "other-worker" }],
        assets: { directory: "./public", binding: "ASSETS" },
        queues: {
          producers: [{ binding: "MY_QUEUE", queue: "my-queue" }],
          consumers: [{ queue: "my-queue" }],
        },
        workflows: [{ binding: "MY_WORKFLOW", name: "my-workflow", class_name: "Greeter" }],
        tail_consumers: [{ service: "tail-worker" }],
      }),
    },
    options: () => ({ wrangler: true, exports: false }),
    assert: (json, { mfOptions }) => {
      expect(json).toMatchObject({
        greeting: "still-serves",
        service: "undefined",
        workflow: "undefined",
        assets: "undefined",
      });
      for (const key of ["assets", "workflows", "queueConsumers", "tails", "streamingTails"]) {
        expect(mfOptions[key]).toBeUndefined();
      }
      // Only the runner's own IPC service binding remains.
      expect(Object.keys(mfOptions.serviceBindings)).toEqual(["__ENV_RUNNER_IPC"]);
    },
    assertWarnings: (warnings) => {
      const dropped = droppedWarnings(warnings);
      expect(dropped).toHaveLength(1);
      for (const part of [
        "services (OTHER_SERVICE)",
        "assets (ASSETS)",
        "queues.consumers (my-queue)",
        "workflows (MY_WORKFLOW)",
        "tail_consumers (tail-worker)",
        "pass them via miniflareOptions",
      ]) {
        expect(dropped[0]).toContain(part);
      }
    },
  },
  {
    name: "dedupes dropped options reported by both the file and inline configs",
    entry: DO_ENTRY,
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        services: [{ binding: "OTHER_SERVICE", service: "other-worker" }],
      }),
    },
    options: () => ({
      wrangler: { services: [{ binding: "OTHER_SERVICE", service: "other-worker" }] },
      exports: false,
    }),
    assert: (json) => expect(json.service).toBe("undefined"),
    assertWarnings: (warnings) => {
      const dropped = droppedWarnings(warnings);
      expect(dropped).toHaveLength(1);
      expect(dropped.join("\n").split("OTHER_SERVICE")).toHaveLength(2);
    },
  },
  {
    name: "defaults defaultPersistRoot next to a loaded config file",
    entry: KV_PUT_ENTRY,
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        kv_namespaces: [{ binding: "MY_KV", id: "kv-id" }],
      }),
    },
    options: () => ({ wrangler: true }),
    assert: (json, { tmpDir, mfOptions }) => {
      expect(json.value).toBe("value");
      const root = join(tmpDir, ".wrangler/state/v3");
      expect(mfOptions.defaultPersistRoot).toBe(root);
      expect(existsSync(join(root, "kv"))).toBe(true);
    },
  },
  {
    name: "does not default defaultPersistRoot when the user configures persistence",
    entry: KV_PUT_ENTRY,
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        kv_namespaces: [{ binding: "MY_KV", id: "kv-id" }],
      }),
    },
    options: () => ({ wrangler: true, miniflareOptions: { kvPersist: false } }),
    assert: (json, { tmpDir, mfOptions }) => {
      expect(json.value).toBe("value");
      expect(mfOptions.defaultPersistRoot).toBeUndefined();
      expect(existsSync(join(tmpDir, ".wrangler"))).toBe(false);
    },
  },
  {
    name: "defaults defaultPersistRoot to cwd for an inline-only config",
    options: () => ({ wrangler: { compatibility_date: "2024-09-01" } }),
    assert: (_json, { mfOptions }) =>
      expect(mfOptions.defaultPersistRoot).toBe(join(process.cwd(), ".wrangler/state/v3")),
  },
  {
    name: "defaults defaultPersistRoot to cwd when wrangler: true finds no config",
    options: () => ({ wrangler: true }),
    assert: (json, { mfOptions }) => {
      expect(json).toEqual({ greeting: null, tier: null });
      expect(mfOptions.defaultPersistRoot).toBe(join(process.cwd(), ".wrangler/state/v3"));
    },
    warns: ["wrangler config requested but none found"],
  },
  {
    name: "anchors defaultPersistRoot to a missing wranglerConfigPath's dir",
    options: ({ tmpDir }) => ({
      wrangler: { compatibility_date: "2024-09-01", vars: { GREETING: "inline" } },
      wranglerConfigPath: join(tmpDir, "config/wrangler.json"),
    }),
    assert: (json, { tmpDir, mfOptions }) => {
      expect(json.greeting).toBe("inline");
      expect(mfOptions.defaultPersistRoot).toBe(join(tmpDir, "config/.wrangler/state/v3"));
    },
    warns: ["wrangler config requested but not found"],
  },
];

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
    name: "keeps file bindings when the inline config fails to load",
    files: {
      "wrangler.json": JSON.stringify({
        name: "test",
        compatibility_date: "2024-09-01",
        vars: { GREETING: "from-file", TIER: "from-file" },
      }),
    },
    // `readConfig` rejects a non-object `vars`.
    options: () => ({ wrangler: { vars: "not-an-object" } }),
    assert: (json, { tmpDir, mfOptions }) => {
      expect(json).toEqual({ greeting: "from-file", tier: "from-file" });
      // The file still counts as loaded (persist root anchored next to it).
      expect(mfOptions.defaultPersistRoot).toBe(join(tmpDir, ".wrangler/state/v3"));
    },
    warns: ["failed to load wrangler config (inline)"],
    assertWarnings: (warnings) =>
      expect(warnings.filter((m) => m.includes("failed to load"))).toHaveLength(1),
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
  defineWranglerCases([...SHARED_CASES, ...INSTALLED_CASES], true);

  it(
    "defaults wranglerEnv to the CLOUDFLARE_ENV variable",
    async () => {
      vi.stubEnv("CLOUDFLARE_ENV", "production");
      try {
        const { json } = await runWranglerCase({
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
  defineWranglerCases([...SHARED_CASES, ...FALLBACK_CASES], false);
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
