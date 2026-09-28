import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import type { EnvRunner } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import { loadTransformer, normalizeTransformOptions } from "../src/common/transform.ts";

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const _dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(_dir, "fixtures/transform", name);

const transform = {
  oxc: { jsx: { runtime: "classic", pragma: "h" } },
  transformers: [fixture("greeting.mjs")],
} as const;

const expected = { tag: "div", props: { kind: "page" }, children: ["Ok", "hi"] };

const runners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  {
    name: "BunProcessEnvRunner",
    create: (opts: any) => new BunProcessEnvRunner(opts),
    skip: !hasRuntime("bun"),
  },
  {
    name: "DenoProcessEnvRunner",
    create: (opts: any) => new DenoProcessEnvRunner(opts),
    skip: !hasRuntime("deno"),
  },
  {
    name: "MiniflareEnvRunner",
    create: (opts: any) => new MiniflareEnvRunner({ miniflare, ...opts }),
  },
];

for (const { name, create, skip } of runners) {
  describe.skipIf(skip ?? false)(`${name} transform`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    it("transforms a .tsx entry and its .ts imports (enums, JSX, custom transformer)", async () => {
      runner = create({ name: "transform", data: { entry: fixture("app.tsx"), transform } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(expected);
    });

    it("re-transforms the entry on reloadModule()", async () => {
      const dir = mkdtempSync(join(tmpdir(), "env-runner-transform-"));
      cpSync(resolve(_dir, "fixtures/transform"), dir, { recursive: true });
      const entry = join(dir, "app.tsx");
      runner = create({ name: "transform-reload", data: { entry, transform } });
      try {
        await runner.waitForReady();
        writeFileSync(entry, readFileSync(entry, "utf8").replace('"page"', '"reloaded"'));
        await runner.reloadModule!();
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual({ ...expected, props: { kind: "reloaded" } });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("transforms matching virtual modules", async () => {
      runner = create({
        name: "transform-virtual",
        data: {
          entry: "#entry.tsx",
          transform,
          virtual: {
            "#entry.tsx": `import { mode } from "#mode.ts";
              const h = (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children });
              export default { fetch: () => Response.json(<b>{mode}{__GREETING__}</b>) };`,
            "#mode.ts": `enum Mode { Dev = "dev" } export const mode: string = Mode.Dev;`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({ tag: "b", children: ["dev", "hi"] });
    });

    // Miniflare transforms per request in its fallback service and serves a
    // module that throws, so the error surfaces from the entry import instead.
    it.skipIf(name === "MiniflareEnvRunner")("closes with the transform error", async () => {
      runner = create({
        name: "transform-error",
        data: { entry: "#bad.tsx", transform, virtual: { "#bad.tsx": "const a = <div>;" } },
      });
      await expect(runner.waitForReady()).rejects.toThrow();
      expect(runner.closed).toBe(true);
    });
  });
}

describe("transform options", () => {
  it("rejects non-specifier transformers", () => {
    expect(() =>
      normalizeTransformOptions({ transformers: [(() => "") as unknown as string] }),
    ).toThrow(/module specifiers/);
    expect(
      () =>
        new NodeWorkerEnvRunner({
          name: "bad",
          data: { entry: fixture("app.tsx"), transform: { transformers: [{} as any] } },
        }),
    ).toThrow(/module specifiers/);
  });

  it("filters by extension and excludes node_modules", async () => {
    const transformer = (await loadTransformer(true))!;
    expect(transformer.filter("/app/src/index.tsx")).toBe(true);
    expect(transformer.filter("/app/src/index.ts?v=1")).toBe(true);
    expect(transformer.filter("/app/src/index.mjs")).toBe(false);
    expect(transformer.filter("/app/node_modules/pkg/index.ts")).toBe(false);
    expect(transformer.filter(String.raw`C:\app\node_modules\pkg\index.ts`)).toBe(false);
  });

  it("reports oxc errors with the file id", async () => {
    const transformer = (await loadTransformer({ sourcemap: false }))!;
    expect(transformer.transform("/app/a.ts", "enum A { B }")).not.toContain("sourceMappingURL");
    expect(() => transformer.transform("/app/bad.tsx", "const a = <div>;")).toThrow(
      /failed to transform "\/app\/bad.tsx"/,
    );
  });

  it("only runs custom transformers with `oxc: false`", async () => {
    const transformer = (await loadTransformer({
      oxc: false,
      transformers: [fixture("greeting.mjs")],
    }))!;
    expect(transformer.transform("/app/a.ts", "const a: string = __GREETING__;")).toBe(
      'const a: string = "hi";',
    );
  });
});
