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
    bun: true,
  },
  {
    name: "DenoProcessEnvRunner",
    create: (opts: any) => new DenoProcessEnvRunner(opts),
    skip: !hasRuntime("deno"),
    // CommonJS falls back to Deno's native loader, which needs this for `.ts`.
    cjsOptions: { execArgv: ["--unstable-detect-cjs"] },
  },
  {
    name: "MiniflareEnvRunner",
    create: (opts: any) => new MiniflareEnvRunner({ miniflare, ...opts }),
    miniflare: true,
  },
];

for (const { name, create, skip, bun, miniflare, cjsOptions } of runners) {
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

    it('runs a rolldown-like plugin object (filter, `order: "pre"`)', async () => {
      runner = create({
        name: "transform-plugin",
        data: {
          entry: fixture("app.tsx"),
          transform: { ...transform, transformers: [fixture("greeting-plugin.mjs")] },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({ ...expected, children: ["Ok", "hi from tsx"] });
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

    it("closes with the transform error", async () => {
      runner = create({
        name: "transform-error",
        data: { entry: "#bad.tsx", transform, virtual: { "#bad.tsx": "const a = <div>;" } },
      });
      await expect(runner.waitForReady()).rejects.toThrow();
      expect(runner.closed).toBe(true);
    });

    it("rejects invalidating a virtual module whose new source fails to transform", async () => {
      let source = `export const value: string = "ok";`;
      runner = create({
        name: "transform-invalidate",
        data: {
          entry: "#entry.ts",
          transform,
          virtual: {
            "#entry.ts": `import { value } from "#value.tsx";
              export default { fetch: () => new Response(value) };`,
            "#value.tsx": () => source,
          },
        },
      });
      await runner.waitForReady();
      source = `export const value = <div>;`;
      await expect(runner.invalidateModule!("#value.tsx")).rejects.toThrow(/#value\.tsx/);
      // The worker survives and keeps serving the previous source.
      expect(runner.ready).toBe(true);
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("ok");
    });

    // Bun evaluates plugin output as ESM, so CommonJS `.ts` can't be transformed there.
    it.skipIf(bun)("serves CommonJS `.ts` (package without `type`) and `.cts`", async () => {
      runner = create({
        ...cjsOptions,
        name: "transform-cjs",
        data: { entry: fixture("app-cjs.ts"), transform },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["lib", "cts"]);
    });

    // workerd can't parse the untransformed TypeScript of an excluded file.
    it.skipIf(miniflare)("leaves excluded paths to the runtime's native loader", async () => {
      runner = create({
        ...cjsOptions,
        name: "transform-exclude",
        data: {
          entry: fixture("app-vendor.ts"),
          transform: { ...transform, exclude: ["/vendor/"] },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "vendor"]);
    });

    // Crosses into the worker serialized, flags included; folded into Bun's filter.
    it.skipIf(miniflare)("only transforms paths matching `include`", async () => {
      runner = create({
        ...cjsOptions,
        name: "transform-include",
        data: {
          entry: fixture("app-vendor.ts"),
          transform: { ...transform, include: /\/TRANSFORM\/(?:app-vendor\.ts|cjs\/dep\.cts)$/i },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "vendor"]);
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

  it("serializes `include` as `{ source, flags }` without stateful flags", () => {
    expect(normalizeTransformOptions({ include: /\/src\//giu })!.include).toEqual({
      source: String.raw`\/src\/`,
      flags: "iu",
    });
    expect(() => normalizeTransformOptions({ include: "/src/" as any })).toThrow(/RegExp/);
    expect(() => normalizeTransformOptions({ include: { source: "(" } })).toThrow();
  });

  it("filters by `include` (tested against `/`-separated paths)", async () => {
    const transformer = (await loadTransformer(
      normalizeTransformOptions({ include: /\/src\//g }),
    ))!;
    // A `g` flag would alternate results through `lastIndex`.
    expect(transformer.filter("/app/src/a.ts")).toBe(true);
    expect(transformer.filter("/app/src/a.ts")).toBe(true);
    expect(transformer.filter(String.raw`C:\app\src\a.ts`)).toBe(true);
    expect(transformer.filter("/app/lib/a.ts")).toBe(false);
    expect(transformer.filter("/app/src/a.mjs")).toBe(false);
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

  it("inlines a source map for the original file", async () => {
    const transformer = (await loadTransformer({}))!;
    const map = decodeMap(transformer.transform("/app/a.ts", "enum A { B }"));
    expect(map.sources).toEqual(["file:///app/a.ts"]);
  });

  it("drops a transformer map that can't be composed with oxc's", async () => {
    const transformer = (await loadTransformer({ transformers: [fixture("mapped.mjs")] }))!;
    expect(transformer.transform("/app/a.ts", "enum A { B }")).not.toContain("sourceMappingURL");
    // Without oxc, the transformer's map is relative to the original source.
    const own = (await loadTransformer({ oxc: false, transformers: [fixture("mapped.mjs")] }))!;
    expect(decodeMap(own.transform("/app/a.js", "a()")).mappings).toBe("AAAA");
  });

  it("orders plugins: pre (source) → oxc → normal/functions (js) → post", async () => {
    const calls: string[] = [];
    (globalThis as any).__transformCalls = calls;
    const transformer = (await loadTransformer({
      transformers: [fixture("order-post.mjs"), fixture("order-fn.mjs"), fixture("order-pre.mjs")],
    }))!;
    transformer.transform("/app/a.ts", "const a: number = 1;");
    expect(calls).toEqual(["pre:ts:typed", "fn:js:untyped", "post:js:untyped"]);
  });

  it("applies rolldown hook filter semantics", async () => {
    const { normalizeTransformer } = await import("../src/common/transform-plugin.ts");
    const matches = (filter: any, id: string, code = "", moduleType = "ts") =>
      normalizeTransformer({ transform: { filter, handler: () => {} } }, "t").matches(
        id,
        code,
        moduleType,
      );
    // Plain values include; exclude wins over include.
    expect(matches({ id: /\.ts$/ }, "/app/a.ts")).toBe(true);
    expect(matches({ id: [/\.tsx$/, "**/*.ts"] }, "/app/a.ts")).toBe(true);
    expect(matches({ id: { include: "**/src/**", exclude: /skip/ } }, "/app/src/skip.ts")).toBe(
      false,
    );
    expect(matches({ id: { exclude: "**/vendor/**" } }, "/app/src/a.ts")).toBe(true);
    // Relative globs resolve from cwd.
    expect(matches({ id: "src/**" }, `${process.cwd()}/src/a.ts`)).toBe(true);
    expect(matches({ id: "src/**" }, "/elsewhere/src/a.ts")).toBe(false);
    // `code` strings are substrings; all properties must match.
    expect(matches({ code: "import.meta.env" }, "/a.ts", "x(import.meta.env.X)")).toBe(true);
    expect(matches({ code: "import.meta.env", id: /\.tsx$/ }, "/a.ts", "import.meta.env")).toBe(
      false,
    );
    expect(matches({ moduleType: ["tsx"] }, "/a.tsx", "", "tsx")).toBe(true);
    expect(matches({ moduleType: { include: ["ts"] } }, "/a.tsx", "", "tsx")).toBe(false);
    // Stateful RegExps don't alternate.
    const g = /a/g;
    expect([matches({ code: g }, "/a.ts", "a"), matches({ code: g }, "/a.ts", "a")]).toEqual([
      true,
      true,
    ]);
  });

  it("rejects invalid transformer exports and async handlers", async () => {
    const { normalizeTransformer } = await import("../src/common/transform-plugin.ts");
    expect(() => normalizeTransformer(undefined, "x")).toThrow(/no usable default export/);
    expect(() => normalizeTransformer({ name: "x" }, "x")).toThrow(/transform/);
    expect(() =>
      normalizeTransformer({ transform: { order: "early", handler() {} } }, "x"),
    ).toThrow(/order/);
    const transformer = (await loadTransformer({
      oxc: false,
      transformers: [fixture("async.mjs")],
    }))!;
    expect(() => transformer.transform("/app/a.ts", "a")).toThrow(/synchronous/);
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

function decodeMap(code: string) {
  const match = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(code);
  expect(match).toBeTruthy();
  return JSON.parse(Buffer.from(match![1]!, "base64").toString());
}
