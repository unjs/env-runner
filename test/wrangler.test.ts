import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as miniflare from "miniflare";
import * as wrangler from "wrangler";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { MiniflareEnvRunnerOptions } from "../src/runners/miniflare/runner.ts";
import { loadWranglerConfig } from "../src/runners/miniflare/wrangler.ts";
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

// Entry that just responds (for tests asserting on runner options).
const OK_ENTRY = `export default {
  fetch() {
    return Response.json({ ok: true });
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
    name: "reads a JSONC config",
    files: {
      "wrangler.jsonc": `{ /* comment */ "name": "test", "compatibility_date": "2024-09-01", "vars": { "GREETING": "from-jsonc", }, }`,
    },
    options: ({ tmpDir }) => ({ wrangler: join(tmpDir, "wrangler.jsonc") }),
    assert: (json) => expect(json.greeting).toBe("from-jsonc"),
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
    warns: ["supports JSON/JSONC only"],
  },
];

describe("MiniflareEnvRunner (wrangler config, fallback reader)", () => {
  defineWranglerCases([...SHARED_CASES, ...FALLBACK_CASES], false);
});

// --- `loadWranglerConfig()` and runner integration details ---

describe("wrangler config loading", () => {
  const COMPAT_DATE = "2025-01-01";
  const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];
  const BACKENDS = [
    { name: "wrangler package", wranglerModule: wrangler },
    { name: "minimal reader", wranglerModule: false as const },
  ];

  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(_dir, ".tmp-wrangler-load-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Parent-dir config notices and wrangler's "Using secrets defined in .dev.vars".
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(files: Record<string, string | object>): void {
    for (const [name, contents] of Object.entries(files)) {
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
    }
  }

  function warnings(): string[] {
    return warn.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  // Inline-only loads without depending on the host filesystem: a missing
  // `configPath` skips auto-discovery (which walks up to `/`), and a stubbed cwd
  // anchors wrangler's dev-vars lookup in the temp dir.
  function pinInlineOnly(): { configPath: string } {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    return { configPath: join(dir, "missing-wrangler.json") };
  }

  function wranglerJson(config: Record<string, unknown>): string {
    return JSON.stringify({ name: "test", compatibility_date: "2024-09-01", ...config });
  }

  // Start a runner on a trivial entry and return the options it passed to Miniflare.
  async function startRunner(
    options: Partial<MiniflareEnvRunnerOptions>,
  ): Promise<Record<string, any>> {
    const entryPath = join(dir, "worker.mjs");
    writeFileSync(entryPath, OK_ENTRY);
    let mfOptions: Record<string, any> = {};
    class CapturingMiniflare extends miniflare.Miniflare {
      constructor(opts: any) {
        mfOptions = opts;
        super(opts);
      }
    }
    runner = new MiniflareEnvRunner({
      name: "wrangler-load",
      miniflare: { ...miniflare, Miniflare: CapturingMiniflare },
      data: { entry: entryPath },
      wranglerModule: false,
      miniflareOptions: { kvPersist: false },
      ...options,
    });
    // Shorter than the test timeout so a startup regression fails readably.
    await runner.waitForReady(15_000);
    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toEqual({ ok: true });
    return mfOptions;
  }

  describe.each(BACKENDS)("$name", ({ wranglerModule }) => {
    describe("config discovery walks up parent directories", () => {
      it(
        "finds a config above both the entry dir and the cwd",
        async () => {
          write({
            "wrangler.json": { compatibility_date: COMPAT_DATE, vars: { GREETING: "root" } },
          });
          mkdirSync(join(dir, "apps/web/src"), { recursive: true });
          vi.spyOn(process, "cwd").mockReturnValue(join(dir, "apps/web"));
          const result = await loadWranglerConfig({
            wrangler: true,
            entryPath: join(dir, "apps/web/src/worker.mjs"),
            wranglerModule,
          });
          expect(result.configFile).toBe(join(dir, "wrangler.json"));
          expect(result.options?.bindings).toMatchObject({ GREETING: "root" });
          expect(warnings().some((m) => m.includes("none found"))).toBe(false);
        },
        WRANGLER_TEST_TIMEOUT,
      );

      it("prefers the nearest directory, then json > jsonc > toml within it", async () => {
        write({
          "wrangler.json": { vars: { GREETING: "root" } },
          "apps/wrangler.json": { vars: { GREETING: "apps" } },
          "apps/wrangler.jsonc": "{}",
          "apps/wrangler.toml": "",
        });
        mkdirSync(join(dir, "apps/web/src"), { recursive: true });
        vi.spyOn(process, "cwd").mockReturnValue(dir);
        const result = await loadWranglerConfig({
          wrangler: true,
          entryPath: join(dir, "apps/web/src/worker.mjs"),
          wranglerModule,
        });
        expect(result.configFile).toBe(join(dir, "apps/wrangler.json"));
      });

      it("announces a config found in a parent of the entry dir once", async () => {
        write({ "apps/web/wrangler.json": { vars: { GREETING: "web" } } });
        mkdirSync(join(dir, "apps/web/src/deep"), { recursive: true });
        vi.spyOn(process, "cwd").mockReturnValue(dir);
        const load = () =>
          loadWranglerConfig({
            wrangler: true,
            entryPath: join(dir, "apps/web/src/deep/worker.mjs"),
            wranglerModule,
          });
        expect((await load()).configFile).toBe(join(dir, "apps/web/wrangler.json"));
        expect((await load()).configFile).toBe(join(dir, "apps/web/wrangler.json"));
        const announced = info.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes(join(dir, "apps/web/wrangler.json")),
        );
        expect(announced).toHaveLength(1);
        expect(String(announced[0]![0])).toContain("wrangler config from a parent directory");
      });

      it.each([
        ["hoisted under node_modules/.pnpm", "node_modules/.pnpm/fw@1.0.0/node_modules/fw/dist"],
        ["in a sibling package", "pkgs/lib/dist"],
      ])(
        "prefers the cwd's config over an ancestor of an out-of-cwd entry (%s)",
        async (_label, entryDir) => {
          write({
            "wrangler.json": { vars: { GREETING: "root" } },
            "apps/web/wrangler.json": { vars: { GREETING: "web" } },
          });
          mkdirSync(join(dir, entryDir), { recursive: true });
          vi.spyOn(process, "cwd").mockReturnValue(join(dir, "apps/web"));
          const result = await loadWranglerConfig({
            wrangler: true,
            entryPath: join(dir, entryDir, "entry.mjs"),
            wranglerModule,
          });
          expect(result.configFile).toBe(join(dir, "apps/web/wrangler.json"));
        },
      );

      it("uses a config in an out-of-cwd entry's own directory", async () => {
        write({
          "pkgs/lib/dist/wrangler.json": { vars: { GREETING: "entry" } },
          "apps/web/wrangler.json": { vars: { GREETING: "web" } },
        });
        vi.spyOn(process, "cwd").mockReturnValue(join(dir, "apps/web"));
        const result = await loadWranglerConfig({
          wrangler: true,
          entryPath: join(dir, "pkgs/lib/dist/entry.mjs"),
          wranglerModule,
        });
        expect(result.configFile).toBe(join(dir, "pkgs/lib/dist/wrangler.json"));
      });

      it("falls back to the cwd's ancestors when the entry's have none", async () => {
        const outside = mkdtempSync(join(_dir, ".tmp-wrangler-load-entry-"));
        try {
          write({ "b/wrangler.json": { vars: { GREETING: "cwd" } } });
          mkdirSync(join(dir, "b/c/d"), { recursive: true });
          vi.spyOn(process, "cwd").mockReturnValue(join(dir, "b/c/d"));
          const result = await loadWranglerConfig({
            wrangler: true,
            entryPath: join(outside, "worker.mjs"),
            wranglerModule,
          });
          expect(result.configFile).toBe(join(dir, "b/wrangler.json"));
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });

      it("warns when no config exists up to the filesystem root", async (ctx) => {
        // Only meaningful when no ancestor of the temp dir has a wrangler config.
        for (let parent = dir; ; parent = dirname(parent)) {
          if (CONFIG_NAMES.some((name) => existsSync(join(parent, name)))) {
            ctx.skip();
          }
          if (dirname(parent) === parent) break;
        }
        mkdirSync(join(dir, "x/y"), { recursive: true });
        vi.spyOn(process, "cwd").mockReturnValue(join(dir, "x/y"));
        const result = await loadWranglerConfig({
          wrangler: true,
          entryPath: join(dir, "x/y/worker.mjs"),
          wranglerModule,
        });
        expect(result).toEqual({});
        expect(
          warnings().some((m) =>
            m.includes(
              "none found (searched the entry's directory, then from the cwd up to the filesystem root)",
            ),
          ),
        ).toBe(true);
      });
    });

    describe("self-referencing Durable Objects", () => {
      it("keeps bindings whose script_name is the config's own name", async () => {
        write({
          "wrangler.json": {
            name: "app",
            compatibility_date: COMPAT_DATE,
            durable_objects: {
              bindings: [
                { name: "SELF_DO", class_name: "Counter", script_name: "app" },
                { name: "LOCAL", class_name: "Greeter" },
                { name: "EXTERNAL", class_name: "Other", script_name: "other-worker" },
              ],
            },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
          },
        });
        const { options } = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          wranglerModule,
        });
        const dos = options?.durableObjects as Record<string, any>;
        expect(Object.keys(dos).sort()).toEqual(["LOCAL", "SELF_DO"]);
        // `scriptName` is stripped, other fields (e.g. `useSQLite`) survive.
        expect(dos.SELF_DO).not.toHaveProperty("scriptName");
        expect(dos.SELF_DO).toMatchObject({ className: "Counter", useSQLite: true });
        expect(dos.LOCAL.className).toBe("Greeter");
        const dropped = droppedWarnings(warnings());
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain('EXTERNAL → script "other-worker"');
        expect(dropped[0]).not.toContain("SELF_DO");
      });

      it("matches the env-normalized worker name (`<name>-<env>`)", async () => {
        write({
          "wrangler.json": {
            name: "app",
            compatibility_date: COMPAT_DATE,
            env: {
              staging: {
                durable_objects: {
                  bindings: [
                    { name: "SELF_DO", class_name: "Counter", script_name: "app-staging" },
                    { name: "TOP", class_name: "Greeter", script_name: "app" },
                  ],
                },
              },
            },
          },
        });
        const { options } = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          env: "staging",
          wranglerModule,
        });
        expect(Object.keys(options?.durableObjects as object)).toEqual(["SELF_DO"]);
        expect(droppedWarnings(warnings())[0]).toContain('TOP → script "app"');
      });

      it("suffixes the name with `-<env>` even when the config has no such env section", async () => {
        write({
          "wrangler.json": {
            name: "app",
            compatibility_date: COMPAT_DATE,
            durable_objects: {
              bindings: [
                { name: "SELF_DO", class_name: "Counter", script_name: "app-staging" },
                { name: "TOP", class_name: "Greeter", script_name: "app" },
              ],
            },
          },
        });
        const { options } = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          env: "staging",
          wranglerModule,
        });
        expect(Object.keys(options?.durableObjects as object)).toEqual(["SELF_DO"]);
        expect(droppedWarnings(warnings())[0]).toContain('TOP → script "app"');
      });

      it("matches file + inline bindings against the effective (merged) worker name", async () => {
        write({
          "wrangler.json": {
            name: "app",
            compatibility_date: COMPAT_DATE,
            durable_objects: {
              bindings: [{ name: "FILE_SELF", class_name: "Counter", script_name: "app" }],
            },
          },
        });
        // No inline `name`: the file's name applies to inline bindings too.
        const unnamed = await loadWranglerConfig({
          wrangler: {
            durable_objects: {
              bindings: [{ name: "INLINE_SELF", class_name: "Greeter", script_name: "app" }],
            },
          },
          configPath: join(dir, "wrangler.json"),
          wranglerModule,
        });
        expect(Object.keys(unnamed.options?.durableObjects as object).sort()).toEqual([
          "FILE_SELF",
          "INLINE_SELF",
        ]);
        expect(droppedWarnings(warnings())).toHaveLength(0);

        // An inline `name` renames the worker: the file's `script_name: "app"`
        // now points at another worker.
        const renamed = await loadWranglerConfig({
          wrangler: {
            name: "renamed",
            durable_objects: {
              bindings: [{ name: "INLINE_SELF", class_name: "Greeter", script_name: "renamed" }],
            },
          },
          configPath: join(dir, "wrangler.json"),
          wranglerModule,
        });
        expect(Object.keys(renamed.options?.durableObjects as object)).toEqual(["INLINE_SELF"]);
        expect(droppedWarnings(warnings())[0]).toContain('FILE_SELF → script "app"');
      });

      it("keeps self-referencing bindings from an inline config", async () => {
        vi.spyOn(process, "cwd").mockReturnValue(dir);
        const { options } = await loadWranglerConfig({
          wrangler: {
            name: "inline-app",
            compatibility_date: COMPAT_DATE,
            durable_objects: {
              bindings: [{ name: "SELF_DO", class_name: "Counter", script_name: "inline-app" }],
            },
          },
          wranglerModule,
        });
        expect(Object.keys(options?.durableObjects as object)).toEqual(["SELF_DO"]);
        expect(droppedWarnings(warnings())).toHaveLength(0);
      });

      it(
        "binds a self-referencing Durable Object in the running worker",
        async () => {
          write({
            "worker.mjs": `import { DurableObject } from "cloudflare:workers";
  export class Counter extends DurableObject {
    count = 0;
    hit() { return ++this.count; }
  }
  export default {
    async fetch(request, env) {
      const stub = env.SELF_DO.get(env.SELF_DO.idFromName("a"));
      await stub.hit();
      return Response.json({ count: await stub.hit(), autoWired: typeof env.COUNTER });
    },
  };`,
            "wrangler.json": {
              name: "app",
              compatibility_date: COMPAT_DATE,
              durable_objects: {
                bindings: [{ name: "SELF_DO", class_name: "Counter", script_name: "app" }],
              },
            },
          });
          runner = new MiniflareEnvRunner({
            name: "self-do",
            miniflare,
            data: { entry: join(dir, "worker.mjs") },
            wrangler: join(dir, "wrangler.json"),
            wranglerModule,
            // Re-export `Counter` from the wrapper (and try to auto-wire it).
            exports: true,
            miniflareOptions: { defaultPersistRoot: join(dir, ".state") },
          });
          await waitForReady(runner, WRANGLER_TEST_TIMEOUT);
          const res = await runner.fetch("http://localhost/");
          // The DO is instantiated and called; `Counter` is already bound by
          // SELF_DO, so no duplicate `COUNTER` binding is auto-wired.
          expect(await res.json()).toEqual({ count: 2, autoWired: "undefined" });
          expect(droppedWarnings(warnings())).toHaveLength(0);
        },
        WRANGLER_TEST_TIMEOUT,
      );
    });

    describe("matches wrangler semantics", () => {
      const BINDINGS_CONFIG = {
        name: "app",
        compatibility_date: COMPAT_DATE,
        kv_namespaces: [{ binding: "KV", id: "kv-id", preview_id: "kv-preview" }],
        r2_buckets: [
          { binding: "R2", bucket_name: "bucket", preview_bucket_name: "bucket-preview" },
        ],
        d1_databases: [{ binding: "D1", database_id: "db-id", preview_database_id: "db-preview" }],
        durable_objects: { bindings: [{ name: "SQL_DO", class_name: "Sql" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Sql", "Unbound"] }],
      };

      // The package returns `{ id }` records, the minimal reader plain ids.
      const localId = (value: unknown) =>
        typeof value === "string" ? value : (value as { id: string }).id;

      it(
        "does not inherit top-level bindings into a named env",
        async () => {
          write({
            "wrangler.json": {
              ...BINDINGS_CONFIG,
              vars: { TOP: "1" },
              env: { staging: { vars: { STAGE: "1" } } },
            },
          });
          const { options } = await loadWranglerConfig({
            wrangler: join(dir, "wrangler.json"),
            env: "staging",
            wranglerModule,
          });
          expect(options?.bindings).toEqual({ STAGE: "1" });
          for (const key of ["kvNamespaces", "r2Buckets", "d1Databases", "durableObjects"]) {
            expect(options).not.toHaveProperty(key);
          }
          // Inheritable `migrations` still register the classes' storage.
          expect(options?.additionalUnboundDurableObjects).toEqual([
            { className: "Sql", useSQLite: true },
            { className: "Unbound", useSQLite: true },
          ]);
        },
        WRANGLER_TEST_TIMEOUT,
      );

      it("fails to load a file whose `env` map lacks the selected env", async () => {
        write({ "wrangler.json": { ...BINDINGS_CONFIG, env: { staging: {} } } });
        const result = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          env: "prod",
          wranglerModule,
        });
        expect(result.configFile).toBeUndefined();
        expect(result.options?.kvNamespaces).toBeUndefined();
        expect(
          warnings().some(
            (m) =>
              m.includes("failed to load wrangler config") &&
              m.includes('No environment found in configuration with name "prod"'),
          ),
        ).toBe(true);
      });

      it("uses preview ids and SQLite storage like `wrangler dev`", async () => {
        write({ "wrangler.json": BINDINGS_CONFIG });
        const { options } = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          wranglerModule,
        });
        const o = options as Record<string, any>;
        expect(localId(o.kvNamespaces.KV)).toBe("kv-preview");
        expect(localId(o.r2Buckets.R2)).toBe("bucket-preview");
        expect(localId(o.d1Databases.D1)).toBe("db-preview");
        expect(o.durableObjects.SQL_DO).toMatchObject({ className: "Sql", useSQLite: true });
        expect(o.additionalUnboundDurableObjects).toEqual([
          { className: "Unbound", useSQLite: true },
        ]);
      });

      it("reads comments and trailing commas in wrangler.json", async () => {
        write({
          "wrangler.json": `{
  // comment with "quotes" and a trailing comma,
  "name": "app", /* block */
  "compatibility_date": "${COMPAT_DATE}",
  "vars": { "URL": "http://example.com/*not-a-comment*/", "LIST": [1, 2,], },
}`,
        });
        const { options, configFile } = await loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          wranglerModule,
        });
        expect(configFile).toBe(join(dir, "wrangler.json"));
        expect(options?.bindings).toEqual({
          URL: "http://example.com/*not-a-comment*/",
          LIST: [1, 2],
        });
      });

      it(
        "loads `.dev.vars.<env>` and `.env` secrets declared under `secrets.required`",
        async () => {
          write({
            "wrangler.json": {
              name: "app",
              compatibility_date: COMPAT_DATE,
              env: {
                staging: {
                  vars: { TIER: "var" },
                  kv_namespaces: [{ binding: "CACHE" }],
                },
                prod: { vars: { TIER: "var" }, secrets: { required: ["API_KEY"] } },
              },
            },
            ".dev.vars": "TIER=dev-vars\n",
            ".dev.vars.staging": "TIER=dev-vars-staging\nCACHE=oops\nEXTRA=1\n",
            ".env": "API_KEY=secret\nJUNK=undeclared\nTIER=dotenv\n",
          });
          const load = (env: string) =>
            loadWranglerConfig({ wrangler: join(dir, "wrangler.json"), env, wranglerModule });

          const staging = (await load("staging")).options;
          expect(staging?.bindings).toEqual({ TIER: "dev-vars-staging", EXTRA: "1" });
          expect(staging?.kvNamespaces).toHaveProperty("CACHE");

          // `.dev.vars` wins over `.env`; move it away to read `.env` under `secrets`.
          rmSync(join(dir, ".dev.vars"));
          rmSync(join(dir, ".dev.vars.staging"));
          expect((await load("prod")).options?.bindings).toEqual({
            TIER: "dotenv",
            API_KEY: "secret",
          });
        },
        WRANGLER_TEST_TIMEOUT,
      );

      it(
        "runs a SQLite-backed Durable Object",
        async () => {
          write({
            "worker.mjs": `import { DurableObject } from "cloudflare:workers";
  export class Sql extends DurableObject {
    query() { return this.ctx.storage.sql.exec("SELECT 1 AS one").one().one; }
  }
  export default {
    async fetch(request, env) {
      return Response.json({ one: await env.SQL_DO.get(env.SQL_DO.idFromName("a")).query() });
    },
  };`,
            "wrangler.json": {
              name: "app",
              compatibility_date: COMPAT_DATE,
              durable_objects: { bindings: [{ name: "SQL_DO", class_name: "Sql" }] },
              migrations: [{ tag: "v1", new_sqlite_classes: ["Sql"] }],
            },
          });
          runner = new MiniflareEnvRunner({
            name: "sqlite-do",
            miniflare,
            data: { entry: join(dir, "worker.mjs") },
            wrangler: join(dir, "wrangler.json"),
            wranglerModule,
            miniflareOptions: { defaultPersistRoot: join(dir, ".state") },
          });
          await waitForReady(runner, WRANGLER_TEST_TIMEOUT);
          const res = await runner.fetch("http://localhost/");
          expect(await res.json()).toEqual({ one: 1 });
        },
        WRANGLER_TEST_TIMEOUT,
      );
    });
  });

  describe("minimal reader warnings", () => {
    it("warns about bindings it can't map", async () => {
      write({
        "wrangler.json": wranglerJson({
          vars: { A: "1" },
          hyperdrive: [{ binding: "HD", id: "hd" }],
          ai: { binding: "AI" },
          ratelimits: [{ name: "LIMITER", namespace_id: "1001" }],
          wasm_modules: { WASM: "./mod.wasm" },
          unsafe: { bindings: [] },
        }),
      });
      const load = () =>
        loadWranglerConfig({
          wrangler: { analytics_engine_datasets: [{ binding: "AE" }], ai: { binding: "AI" } },
          configPath: join(dir, "wrangler.json"),
          wranglerModule: false,
        });
      expect((await load()).options?.bindings).toEqual({ A: "1" });
      const unsupported = warnings().filter((m) => m.includes("not supported by the built-in"));
      expect(unsupported).toHaveLength(1);
      for (const part of [
        "hyperdrive (HD)",
        "ai (AI)",
        "ratelimits (LIMITER)",
        "wasm_modules (WASM)",
        "analytics_engine_datasets (AE)",
        "install 'wrangler'",
      ]) {
        expect(unsupported[0]).toContain(part);
      }
      expect(unsupported[0]).not.toContain("unsafe");
      expect(unsupported[0]!.split("AI")).toHaveLength(2);
    });
  });

  describe("inline config keeps nested file options", () => {
    it(
      "does not clobber the file's `send_email` with the inline `email: { send_email: [] }`",
      async () => {
        write({ "wrangler.json": wranglerJson({ send_email: [{ name: "MAIL" }] }) });
        const { options } = await loadWranglerConfig({
          wrangler: { vars: { A: "1" } },
          configPath: join(dir, "wrangler.json"),
          wranglerModule: wrangler,
        });
        expect(options?.email).toEqual({ send_email: [{ name: "MAIL" }] });
        expect(options?.bindings).toEqual({ A: "1" });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "drops all-empty wrapper options but keeps `{}`-valued bindings and JSON vars",
      async () => {
        const { options } = await loadWranglerConfig({
          wrangler: {
            compatibility_date: "2024-09-01",
            vars: { LIST: [] },
            worker_loaders: [{ binding: "LOADER" }],
          },
          ...pinInlineOnly(),
          wranglerModule: wrangler,
        });
        expect(options).not.toHaveProperty("email");
        expect(options?.bindings).toEqual({ LIST: [] });
        expect(options?.workerLoaders).toEqual({ LOADER: {} });
      },
      WRANGLER_TEST_TIMEOUT,
    );
  });

  describe("`no_nodejs_compat`", () => {
    it(
      "does not force `nodejs_compat` when a wrangler config opts out",
      async () => {
        const mfOptions = await startRunner({
          wrangler: { compatibility_date: "2024-09-23", compatibility_flags: ["no_nodejs_compat"] },
        });
        expect(mfOptions.compatibilityFlags).toEqual(["no_nodejs_compat"]);
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "does not force `nodejs_compat` when a wrangler config opts out (wrangler package)",
      async () => {
        const mfOptions = await startRunner({
          wrangler: { compatibility_date: "2024-09-23", compatibility_flags: ["no_nodejs_compat"] },
          wranglerConfigPath: pinInlineOnly().configPath,
          wranglerModule: wrangler,
        });
        expect(mfOptions.compatibilityFlags).toEqual(["no_nodejs_compat"]);
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "lets a user `no_nodejs_compat` drop a wrangler `nodejs_compat`",
      async () => {
        const mfOptions = await startRunner({
          wrangler: { compatibility_date: "2024-09-23", compatibility_flags: ["nodejs_compat"] },
          miniflareOptions: { kvPersist: false, compatibilityFlags: ["no_nodejs_compat"] },
        });
        expect(mfOptions.compatibilityFlags).toEqual(["no_nodejs_compat"]);
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "does not force `nodejs_compat` when miniflareOptions opt out",
      async () => {
        const mfOptions = await startRunner({
          miniflareOptions: {
            compatibilityDate: "2024-09-23",
            compatibilityFlags: ["no_nodejs_compat"],
          },
        });
        expect(mfOptions.compatibilityFlags).toEqual(["no_nodejs_compat"]);
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "still defaults to `nodejs_compat`",
      async () => {
        const mfOptions = await startRunner({
          miniflareOptions: { compatibilityFlags: ["global_fetch_strictly_public"] },
        });
        expect(mfOptions.compatibilityFlags).toEqual([
          "nodejs_compat",
          "global_fetch_strictly_public",
        ]);
      },
      WRANGLER_TEST_TIMEOUT,
    );
  });

  describe("inline config dev vars", () => {
    it(
      "loads `.dev.vars` from cwd for an inline-only config",
      async () => {
        write({ ".dev.vars": "SECRET=from-dev-vars\n" });
        const { options, configFile } = await loadWranglerConfig({
          wrangler: { compatibility_date: "2024-09-01", vars: { SECRET: "inline", OTHER: "x" } },
          ...pinInlineOnly(),
          wranglerModule: wrangler,
        });
        expect(configFile).toBeUndefined();
        expect(options?.bindings).toEqual({ SECRET: "from-dev-vars", OTHER: "x" });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "does not let inline `vars` override the file's `.dev.vars` secrets",
      async () => {
        write({
          "config/wrangler.json": wranglerJson({ vars: { SECRET: "file", TIER: "file" } }),
          "config/.dev.vars": "SECRET=from-dev-vars\n",
        });
        const { options } = await loadWranglerConfig({
          wrangler: { vars: { SECRET: "inline", GREETING: "inline" } },
          configPath: join(dir, "config/wrangler.json"),
          wranglerModule: wrangler,
        });
        expect(options?.bindings).toEqual({
          SECRET: "from-dev-vars",
          TIER: "file",
          GREETING: "inline",
        });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "uses `.dev.vars.<env>` even when the inline config doesn't define the env",
      async () => {
        write({
          "config/wrangler.json": wranglerJson({
            vars: { SECRET: "file" },
            env: { staging: { vars: { SECRET: "file-staging" } } },
          }),
          "config/.dev.vars": "SECRET=from-dev-vars\n",
          "config/.dev.vars.staging": "SECRET=from-dev-vars-staging\n",
        });
        const { options } = await loadWranglerConfig({
          wrangler: { vars: { SECRET: "inline" } },
          configPath: join(dir, "config/wrangler.json"),
          env: "staging",
          wranglerModule: wrangler,
        });
        expect(options?.bindings).toEqual({ SECRET: "from-dev-vars-staging" });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "loads `.env` from the config file's dir for an inline config",
      async () => {
        write({
          "config/wrangler.json": wranglerJson({}),
          "config/.env": "SECRET=from-dot-env\n",
        });
        const { options } = await loadWranglerConfig({
          wrangler: { vars: { SECRET: "inline" } },
          configPath: join(dir, "config/wrangler.json"),
          wranglerModule: wrangler,
        });
        expect(options?.bindings).toEqual({ SECRET: "from-dot-env" });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "does not leak undeclared `.dev.vars` keys through an inline config",
      async () => {
        write({
          "wrangler.json": wranglerJson({
            vars: { TIER: "file" },
            secrets: { required: ["API_KEY"] },
            kv_namespaces: [{ binding: "CACHE" }],
          }),
          ".dev.vars": "API_KEY=real\nJUNK=leaked\nCACHE=oops\n",
        });
        const load = (inline?: Record<string, unknown>) =>
          loadWranglerConfig({
            wrangler: inline ?? true,
            configPath: join(dir, "wrangler.json"),
            wranglerModule: wrangler,
          });
        const fileOnly = await load();
        expect(fileOnly.options?.bindings).toEqual({ TIER: "file", API_KEY: "real" });
        const merged = await load({ vars: { X: "1" } });
        expect(merged.options?.bindings).toEqual({ TIER: "file", API_KEY: "real", X: "1" });
        expect(merged.options?.kvNamespaces).toHaveProperty("CACHE");
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "reads the inline config under the file's `secrets` (process.env secrets win over inline vars)",
      async () => {
        write({
          "wrangler.json": wranglerJson({ secrets: { required: ["API_KEY"] } }),
        });
        vi.stubEnv("API_KEY", "from-process-env");
        try {
          const { options } = await loadWranglerConfig({
            wrangler: { vars: { API_KEY: "inline" } },
            configPath: join(dir, "wrangler.json"),
            wranglerModule: wrangler,
          });
          expect(options?.bindings).toEqual({ API_KEY: "from-process-env" });
        } finally {
          vi.unstubAllEnvs();
        }
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "does not leak `.dev.vars` keys that name another binding type without `secrets`",
      async () => {
        write({
          "wrangler.json": wranglerJson({ kv_namespaces: [{ binding: "CACHE" }] }),
          ".dev.vars": "API_KEY=real\nCACHE=oops\n",
        });
        const { options } = await loadWranglerConfig({
          wrangler: { vars: { X: "1" } },
          configPath: join(dir, "wrangler.json"),
          wranglerModule: wrangler,
        });
        expect(options?.bindings).toEqual({ API_KEY: "real", X: "1" });
      },
      WRANGLER_TEST_TIMEOUT,
    );

    it(
      "anchors inline dev vars at a config file that fails to load",
      async () => {
        write({
          "config/wrangler.json": wranglerJson({ vars: "not-an-object" }),
          "config/.dev.vars": "SECRET=from-config-dir\n",
          ".dev.vars": "SECRET=from-cwd\n",
        });
        vi.spyOn(process, "cwd").mockReturnValue(dir);
        const { options, configFile } = await loadWranglerConfig({
          wrangler: { compatibility_date: "2024-09-01", vars: { SECRET: "inline" } },
          configPath: join(dir, "config/wrangler.json"),
          wranglerModule: wrangler,
        });
        expect(configFile).toBeUndefined();
        expect(options?.bindings).toEqual({ SECRET: "from-config-dir" });
      },
      WRANGLER_TEST_TIMEOUT,
    );
  });

  describe("wrangler warnings (wrangler package)", () => {
    const MISSING_ENV = 'No environment found in configuration with name "nope"';

    it("surfaces warnings for a config file once per file version and env", async () => {
      const config = { name: "app", compatibility_date: COMPAT_DATE };
      write({ "wrangler.json": config });
      const load = (env: string) =>
        loadWranglerConfig({
          wrangler: join(dir, "wrangler.json"),
          env,
          wranglerModule: wrangler,
        });
      const count = () => warnings().filter((m) => m.includes(MISSING_ENV)).length;

      await load("nope");
      expect(count()).toBe(1);
      // Re-init / hot reload with the same file: not repeated.
      await load("nope");
      expect(count()).toBe(1);
      // Editing the file shows them again.
      write({ "wrangler.json": { ...config, vars: { CHANGED: "1" } } });
      await load("nope");
      expect(count()).toBe(2);
      // A relative `wranglerConfigPath` for the same file shares the dedupe key.
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      await loadWranglerConfig({
        wrangler: true,
        configPath: "./wrangler.json",
        env: "nope",
        wranglerModule: wrangler,
      });
      expect(count()).toBe(2);
    });

    it("keeps wrangler warnings hidden for inline configs", async () => {
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      await loadWranglerConfig({
        wrangler: { compatibility_date: COMPAT_DATE, not_a_wrangler_key: true },
        wranglerModule: wrangler,
      });
      expect(warnings().some((m) => m.includes("env-runner-wrangler-"))).toBe(false);
      expect(warnings().some((m) => m.includes("not_a_wrangler_key"))).toBe(false);
    });
  });

  describe.each(BACKENDS)("wranglerEnvFiles ($name)", ({ wranglerModule }) => {
    function writeProject() {
      write({
        "config/wrangler.json": {
          name: "app",
          compatibility_date: COMPAT_DATE,
          vars: { GREETING: "from-config" },
        },
        "config/.dev.vars": "TIER=from-dev-vars\n",
        "config/.env.custom": "GREETING=from-env-file\n",
        "config/.env.override": "GREETING=from-override\n",
      });
    }

    it("loads custom env files relative to the config dir instead of .dev.vars", async () => {
      writeProject();
      const load = (envFiles?: string[]) =>
        loadWranglerConfig({
          wrangler: join(dir, "config/wrangler.json"),
          envFiles,
          wranglerModule,
        });

      // Default: `.dev.vars` is read.
      expect((await load()).options?.bindings).toMatchObject({
        GREETING: "from-config",
        TIER: "from-dev-vars",
      });
      // Custom files: `.dev.vars` skipped, later files override earlier ones.
      const custom = (await load([".env.custom", ".env.override"])).options?.bindings as Record<
        string,
        unknown
      >;
      expect(custom).toMatchObject({ GREETING: "from-override" });
      expect(custom).not.toHaveProperty("TIER");

      // `[]`: `.dev.vars` is still read, but no default `.env*` files.
      write({ "config/.env": "EXTRA=from-dotenv\n" });
      expect((await load([])).options?.bindings).toMatchObject({ TIER: "from-dev-vars" });
      rmSync(join(dir, "config/.dev.vars"));
      const empty = (await load([])).options?.bindings as Record<string, unknown>;
      expect(empty).not.toHaveProperty("EXTRA");
      // ...whereas unset falls back to `.env` when there is no `.dev.vars`.
      expect((await load()).options?.bindings).toMatchObject({ EXTRA: "from-dotenv" });
    });

    it(
      "plumbs the runner's wranglerEnvFiles option to the worker env",
      async () => {
        writeProject();
        write({
          "worker.mjs": `export default {
    fetch(request, env) {
      return Response.json({ greeting: env.GREETING ?? null, tier: env.TIER ?? null });
    },
  };`,
        });
        runner = new MiniflareEnvRunner({
          name: "env-files",
          miniflare,
          data: { entry: join(dir, "worker.mjs") },
          wrangler: join(dir, "config/wrangler.json"),
          wranglerEnvFiles: [".env.custom"],
          wranglerModule,
        });
        await waitForReady(runner, WRANGLER_TEST_TIMEOUT);
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual({ greeting: "from-env-file", tier: null });
      },
      WRANGLER_TEST_TIMEOUT,
    );
  });
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
