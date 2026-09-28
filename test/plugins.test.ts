import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { transformSync } from "oxc-transform";

import type { EnvRunner, EnvRunnerPlugin } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import { createPluginPipeline, transformVirtualModules } from "../src/common/plugins.ts";
import { createPrefilter } from "../src/common/plugin-filter.ts";
import { createBunFilter, transformedFormat } from "../src/common/plugin-hooks.ts";

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const _dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(_dir, "fixtures/plugins", name);

// A TypeScript/JSX plugin with `oxc-transform`, as an app would write it. The
// handler is async: it runs on the host.
function oxc(options: { id?: unknown } = {}): EnvRunnerPlugin {
  return {
    name: "oxc",
    transform: {
      filter: { moduleType: ["ts", "tsx", "jsx"], ...(options.id ? { id: options.id } : {}) },
      async handler(code, path, { moduleType }) {
        await new Promise((r) => setTimeout(r, 1));
        const result = transformSync(path, code, {
          sourcemap: true,
          lang: moduleType as "ts",
          jsx: { runtime: "classic", pragma: "h" },
        });
        const errors = result.errors.filter((error) => error.severity === "Error");
        if (errors.length > 0) {
          this.error(errors.map((error) => error.message).join("\n"));
        }
        return { code: result.code, map: result.map, moduleType: "js" };
      },
    },
  } as EnvRunnerPlugin;
}

// Replaces `__GREETING__`, recording the ids it saw (host-side state).
function greeting(opts: { greeting?: string; id?: any; seen?: string[] } = {}): EnvRunnerPlugin {
  return {
    name: "greeting",
    transform: {
      filter: { code: "__GREETING__", ...(opts.id ? { id: opts.id } : {}) },
      handler(code, id) {
        opts.seen?.push(id);
        return code.replaceAll("__GREETING__", JSON.stringify(opts.greeting ?? "hi"));
      },
    },
  };
}

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
    // CommonJS falls back to Deno's native loader, which needs this for `.ts`.
    cjsOptions: { execArgv: ["--unstable-detect-cjs"] },
  },
  {
    name: "MiniflareEnvRunner",
    create: (opts: any) => new MiniflareEnvRunner({ miniflare, ...opts }),
  },
];

for (const { name, create, skip, cjsOptions } of runners) {
  const miniflareRunner = name === "MiniflareEnvRunner";
  describe.skipIf(skip ?? false)(`${name} plugins`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    it("transforms a .tsx entry and its .ts imports on the host", async () => {
      const seen: string[] = [];
      runner = create({
        name: "plugins",
        data: { entry: fixture("app.tsx"), plugins: [oxc(), greeting({ seen })] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(expected);
      // The handler ran in this process, with the file path as id.
      expect(seen).toEqual([fixture("app.tsx")]);
    });

    it('runs `order: "pre"` handlers first', async () => {
      const pre: EnvRunnerPlugin = {
        name: "pre",
        transform: {
          order: "pre",
          filter: { moduleType: ["tsx"] },
          // Still TSX here, although listed after oxc.
          handler: (code, _id, { moduleType }) =>
            code.replace("{__GREETING__}", `{${JSON.stringify(`hey from ${moduleType}`)}}`),
        },
      };
      runner = create({
        name: "plugins-pre",
        data: { entry: fixture("app.tsx"), plugins: [oxc(), pre] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({ ...expected, children: ["Ok", "hey from tsx"] });
    });

    it("re-transforms the entry on reloadModule()", async () => {
      const dir = mkdtempSync(join(tmpdir(), "env-runner-plugins-"));
      cpSync(resolve(_dir, "fixtures/plugins"), dir, { recursive: true });
      const entry = join(dir, "app.tsx");
      runner = create({
        name: "plugins-reload",
        data: { entry, plugins: [oxc(), greeting()] },
      });
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

    it("transforms matching virtual modules (by extension or format)", async () => {
      runner = create({
        name: "plugins-virtual",
        data: {
          entry: "#entry.tsx",
          plugins: [oxc(), greeting()],
          virtual: {
            "#entry.tsx": `import { mode } from "#mode.ts";
              import view from "#view";
              const h = (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children });
              export default { fetch: () => Response.json(<b>{mode}{__GREETING__}{view}</b>) };`,
            "#mode.ts": `enum Mode { Dev = "dev" } export const mode: string = Mode.Dev;`,
            "#view": {
              source: `enum Tag { I = "i" }
                const h = (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children });
                export default <i>{Tag.I}</i>;`,
              format: "tsx",
            },
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({
        tag: "b",
        children: ["dev", "hi", { tag: "i", children: ["i"] }],
      });
    });

    it("closes with the transform error of a disk module", async () => {
      const failing: EnvRunnerPlugin = {
        name: "failing",
        transform: {
          filter: { id: /dep\.ts$/ },
          handler() {
            throw new Error("nope");
          },
        },
      };
      runner = create({
        name: "plugins-error",
        data: { entry: fixture("app.tsx"), plugins: [failing, oxc()] },
      });
      // Miniflare: a named import fails to link first (the error is logged on the host).
      const error = await runner.waitForReady().catch((error) => error);
      expect(error.cause.message).toMatch(
        miniflareRunner
          ? /Status/
          : /^\[env-runner\] plugin "failing" failed on ".*dep\.ts": nope$/,
      );
      expect(runner.closed).toBe(true);
    });

    it("rejects invalidating a virtual module whose new source fails to transform", async () => {
      let source = `export const value: string = "ok";`;
      runner = create({
        name: "plugins-invalidate",
        data: {
          entry: "#entry.ts",
          plugins: [oxc()],
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

    it("serves CommonJS `.ts` (package without `type`), `.cts` and untouched `.js`", async () => {
      // The glob-only `id` filter sends every script file through Bun's
      // `onLoad`, including the untouched CommonJS `plain.js`.
      runner = create({
        ...cjsOptions,
        name: "plugins-cjs",
        data: { entry: fixture("app-cjs.ts"), plugins: [oxc(), greeting({ id: "**/cjs/**" })] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["lib", "cts", "plain"]);
    });

    it("leaves TypeScript no plugin compiled to the runtime", async () => {
      runner = create({
        name: "plugins-typed",
        data: { entry: fixture("typed.ts"), plugins: [greeting()] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hi");
    });

    it("serves a virtual path key over the file plugins would transform", async () => {
      runner = create({
        ...cjsOptions,
        name: "plugins-virtual-path",
        data: {
          entry: fixture("app-vendor.ts"),
          plugins: [oxc(), greeting()],
          virtual: { [fixture("vendor/plain.ts")]: `export const value: string = "virtual";` },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "virtual"]);
    });

    // `vendor/plain.ts` would become "hi" if the greeting plugin ran on it.
    it("scopes a plugin with `id` filters (glob exclude, RegExp include)", async () => {
      for (const id of [{ exclude: "**/vendor/**" }, /Plugins[/\\](?:app-vendor|cjs)/i]) {
        runner = create({
          ...cjsOptions,
          name: "plugins-id",
          data: {
            entry: fixture("app-vendor.ts"),
            plugins: [oxc(), { ...greeting({ id }), name: "greeting" }],
          },
        });
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual(["cts", "vendor"]);
        await runner.close();
      }
    });
  });
}

describe("MiniflareEnvRunner plugins (persistent)", () => {
  it("runs the plugins of the runner that adopted the instance", async () => {
    const create = (value: string) =>
      new MiniflareEnvRunner({
        miniflare,
        persistent: true,
        name: "plugins-persistent",
        data: { entry: fixture("typed.ts"), plugins: [greeting({ greeting: value })] },
      } as any);
    const first = create("one");
    await first.waitForReady();
    expect(await (await first.fetch("http://localhost/")).text()).toBe("one");
    await first.close();
    const second = create("two");
    try {
      await second.waitForReady();
      await second.reloadModule();
      expect(await (await second.fetch("http://localhost/")).text()).toBe("two");
    } finally {
      await second.close();
    }
  });
});

describe("plugins", () => {
  it("validates `data.plugins`", () => {
    expect(createPluginPipeline(undefined)).toBeUndefined();
    expect(createPluginPipeline(null as any)).toBeUndefined();
    expect(() =>
      createPluginPipeline([{ transform: { filter: { moduleType: "ts" as any }, handler() {} } }]),
    ).toThrow(/invalid `transform\.filter\.moduleType`/);
    expect(() => createPluginPipeline("oxc" as any)).toThrow(/must be an array/);
    expect(() => createPluginPipeline([{} as any])).toThrow(
      /`data\.plugins\[0\]` has no `transform`/,
    );
    expect(() => createPluginPipeline([(() => {}) as any])).toThrow(/is not a plugin object/);
    expect(() =>
      createPluginPipeline([{ transform: { order: "first", handler() {} } } as any]),
    ).toThrow(/invalid `transform\.order`/);
    expect(
      () =>
        new NodeWorkerEnvRunner({
          name: "bad",
          data: { entry: fixture("app.tsx"), plugins: [{} as any] },
        }),
    ).toThrow(/data\.plugins\[0\]/);
  });

  it("closes the self runner", async () => {
    const runner = new SelfEnvRunner({
      name: "self",
      data: { entry: fixture("app.tsx"), plugins: [oxc()] },
    });
    await expect(runner.waitForReady()).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/self runner does not support plugins/) },
    });
  });

  it("only runs script modules outside node_modules", () => {
    const pipeline = createPluginPipeline([greeting()])!;
    for (const ext of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]) {
      expect(pipeline.filter(`/app/src/index${ext}`)).toBe(true);
    }
    expect(pipeline.filter("/app/src/index.ts?v=1")).toBe(true);
    expect(pipeline.filter("/app/src/data.json")).toBe(false);
    expect(pipeline.filter("/app/node_modules/pkg/index.ts")).toBe(false);
    expect(pipeline.filter(String.raw`C:\app\node_modules\pkg\index.ts`)).toBe(false);
    // Virtual modules: by their format's module type.
    expect(pipeline.filter("#virtual", "js")).toBe(true);
  });

  it("sends the `id`/`moduleType` filters to the worker's prefilter", () => {
    const pipeline = createPluginPipeline([
      oxc({ id: { exclude: "**/vendor/**" } }),
      greeting({ id: /plugins[/\\]app/i }),
    ])!;
    // Serializable: RegExps as source and flags, globs resolved from cwd.
    const prefilters = JSON.parse(JSON.stringify(pipeline.prefilters));
    expect(prefilters).toEqual([
      {
        id: { include: [], exclude: ["**/vendor/**"] },
        moduleTypes: ["ts", "tsx", "jsx"],
      },
      { id: { include: [{ source: String.raw`plugins[/\\]app`, flags: "i" }], exclude: [] } },
    ]);
    const prefilter = createPrefilter(prefilters);
    expect(prefilter("/app/a.ts", "ts")).toBe(true);
    expect(prefilter("/app/vendor/a.ts", "ts")).toBe(false);
    expect(prefilter("/app/a.js", "js")).toBe(false);
    expect(prefilter("/x/Plugins/app.js", "js")).toBe(true);
  });

  it("runs handlers by order, with filters, source maps and module types", async () => {
    const calls: string[] = [];
    const pipeline = createPluginPipeline([
      { name: "a", transform: (code) => (calls.push("a"), code + "//a") },
      {
        name: "b",
        transform: { order: "post", handler: (code) => (calls.push("b"), code + "//b") },
      },
      {
        name: "c",
        transform: {
          order: "pre",
          filter: { code: /TS_ONLY/ },
          handler: () => ({
            code: "export const x = 1;",
            map: { mappings: "AAAA", sources: ["x"] },
            moduleType: "js",
          }),
        },
      },
      { name: "skipped", transform: { filter: { moduleType: ["tsx"] }, handler: () => "nope" } },
    ])!;
    const result = await pipeline.transform("/app/a.ts?v=1", "TS_ONLY");
    expect(calls).toEqual(["a", "b"]);
    const [code, map] = result!.code.split("\n//# sourceMappingURL=data:application/json;base64,");
    expect(code).toBe("export const x = 1;//a//b");
    expect(JSON.parse(Buffer.from(map!, "base64").toString())).toEqual({
      mappings: "AAAA",
      sources: ["file:///app/a.ts"],
    });
    // Unchanged code, changed code that is still TypeScript (left to the
    // runtime), and still JSX.
    expect(await createPluginPipeline([{ transform: () => null }])!.transform("/a.ts", "x")).toBe(
      undefined,
    );
    const append = createPluginPipeline([{ transform: (code) => code + ";" }])!;
    expect(await append.transform("/a.ts", "x")).toEqual({ code: "x;", moduleType: "ts" });
    await expect(append.transform("/a.tsx", "x")).rejects.toThrow(/still tsx after its plugins/);
    await expect(
      createPluginPipeline([{ transform: () => ({ code: 1 as any }) }])!.transform("/a.js", "x"),
    ).rejects.toThrow(/non-string `code`/);
  });

  it("transforms virtual modules in their format's module system", async () => {
    const pipeline = createPluginPipeline([oxc()])!;
    const untouched = { source: "export default 1;", format: "module" as const };
    const out = await transformVirtualModules(pipeline, {
      "#a": untouched,
      "#b.cts": "const x: number = 1; module.exports = x;",
      "#c": { source: "export default <b />;", format: "jsx" as const },
      "#d": null,
    });
    expect(out["#a"]).toBe(untouched);
    expect(out["#b.cts"]).toMatchObject({ format: "commonjs" });
    expect(out["#c"]).toMatchObject({ format: "module", source: expect.stringContaining("h(") });
    expect(out["#d"]).toBeNull();
  });

  it("warns once when two plugins return source maps", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mapped = (name: string): EnvRunnerPlugin => ({
      name,
      transform: (code) => ({ code: code + ";", map: { mappings: "" } }),
    });
    const pipeline = createPluginPipeline([mapped("m1"), mapped("m2")])!;
    expect((await pipeline.transform("/a.js", "x"))!.code).toBe("x;;");
    await pipeline.transform("/b.js", "x");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("builds Bun's `onLoad` filter from the prefilters", () => {
    const filter = (prefilters: any[]) => createBunFilter(prefilters);
    const all = filter([{}]);
    expect(all.test("/app/a.ts")).toBe(true);
    expect(all.test("/app/a.cts")).toBe(false);
    expect(all.test("/app/node_modules/x/a.ts")).toBe(false);
    expect(all.test(String.raw`C:\app\node_modules\x\a.ts`)).toBe(false);
    const typed = filter([{ moduleTypes: ["tsx"] }]);
    expect(typed.test("/app/a.tsx")).toBe(true);
    expect(typed.test("/app/a.ts")).toBe(false);
    const scoped = filter([
      {
        id: {
          include: [{ source: "src", flags: "" }],
          exclude: [{ source: "gen", flags: "" }],
        },
      },
    ]);
    expect(scoped.test("/app/src/a.ts")).toBe(true);
    expect(scoped.test("/app/src/gen/a.ts")).toBe(false);
    expect(scoped.test("/app/lib/a.ts")).toBe(false);
    // Globs are left to the prefilter.
    expect(filter([{ id: { include: ["/app/src/**"], exclude: [] } }]).test("/x/a.ts")).toBe(true);
    // Mixed flags: no `id` folding.
    const mixed = filter([
      { id: { include: [{ source: "a", flags: "i" }], exclude: [] } },
      { id: { include: [{ source: "b", flags: "" }], exclude: [] } },
    ]);
    expect(mixed.test("/x/c.ts")).toBe(true);
  });

  it("detects the format of transformed code", async () => {
    await (
      await import("es-module-lexer")
    ).init;
    expect(transformedFormat("/a.ts", "module.exports = 1", "module-typescript")).toBe("module");
    expect(transformedFormat("/a.ts", "export default 1", "commonjs-typescript")).toBe("commonjs");
    expect(transformedFormat("/a.mts", "module.exports = 1")).toBe("module");
    expect(transformedFormat("/a.cts", "export default 1")).toBe("commonjs");
    expect(transformedFormat("/a.tsx", "export default 1")).toBe("module");
    expect(transformedFormat("/a.tsx", "module.exports = 1")).toBe("commonjs");
    expect(transformedFormat("/a.tsx", "import x from 'y'; module.exports = x")).toBe("module");
  });
});
