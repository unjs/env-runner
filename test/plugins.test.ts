import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";

import type { EnvRunner } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import {
  createBunFilter,
  loadPlugins,
  normalizePluginEntries,
  transformVirtualModule,
} from "../src/common/plugins.ts";
import { resolvePlugin } from "../src/common/plugin.ts";

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

// A TypeScript/JSX plugin with `oxc-transform`, as an app would write it.
const oxc = fixture("oxc.mjs");
const oxcEntry = [oxc, { jsx: { runtime: "classic", pragma: "h" } }] as [string, unknown];

const plugins = [oxcEntry, fixture("greeting.mjs")];

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
  },
];

for (const { name, create, skip, bun, cjsOptions } of runners) {
  describe.skipIf(skip ?? false)(`${name} plugins`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    it("transforms a .tsx entry and its .ts imports (enums, JSX, custom plugin)", async () => {
      runner = create({ name: "plugins", data: { entry: fixture("app.tsx"), plugins } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(expected);
    });

    it('runs a plugin object (filter, `order: "pre"`)', async () => {
      runner = create({
        name: "plugins-object",
        data: {
          entry: fixture("app.tsx"),
          plugins: [oxcEntry, [fixture("greeting-plugin.mjs"), { greeting: "hey" }]],
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      // `pre` ran on the TSX source although listed after oxc; options reached the hook.
      expect(await res.json()).toEqual({ ...expected, children: ["Ok", "hey from tsx"] });
    });

    it("re-transforms the entry on reloadModule()", async () => {
      const dir = mkdtempSync(join(tmpdir(), "env-runner-plugins-"));
      cpSync(resolve(_dir, "fixtures/plugins"), dir, { recursive: true });
      const entry = join(dir, "app.tsx");
      runner = create({ name: "plugins-reload", data: { entry, plugins } });
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
        name: "plugins-virtual",
        data: {
          entry: "#entry.tsx",
          plugins,
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

    it("transforms a virtual module by its TypeScript/JSX format (no extension)", async () => {
      runner = create({
        name: "plugins-virtual-format",
        data: {
          entry: "#entry",
          plugins,
          virtual: {
            "#entry": `import view from "#view";
              export default { fetch: () => Response.json(view) };`,
            "#view": {
              source: `enum Tag { B = "b" }
                const h = (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children });
                export default <b>{Tag.B}</b>;`,
              format: "tsx",
            },
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({ tag: "b", children: ["b"] });
    });

    it("closes with the transform error", async () => {
      runner = create({
        name: "plugins-error",
        data: { entry: "#bad.tsx", plugins, virtual: { "#bad.tsx": "const a = <div>;" } },
      });
      await expect(runner.waitForReady()).rejects.toThrow();
      expect(runner.closed).toBe(true);
    });

    it("rejects invalidating a virtual module whose new source fails to transform", async () => {
      let source = `export const value: string = "ok";`;
      runner = create({
        name: "plugins-invalidate",
        data: {
          entry: "#entry.ts",
          plugins,
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

    it("transforms an invalidated virtual module source once", async () => {
      let source = `export const count: number = __COUNT__;`;
      runner = create({
        name: "plugins-invalidate-once",
        data: {
          // The entry has no `__COUNT__`, so only `#count.ts` is counted.
          entry: "#entry",
          plugins: [oxc, fixture("count.mjs")],
          virtual: {
            "#entry": `import { count } from "#count.ts";
              export default { fetch: () => new Response(String(count)) };`,
            "#count.ts": () => source,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("1");
      source = `export const count: number = __COUNT__; // edited`;
      await runner.invalidateModule!("#count.ts");
      await runner.reloadModule!();
      // Validation at invalidation and the reload share one transform.
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("2");
    });

    // Bun evaluates plugin output as ESM, so CommonJS `.ts` can't be transformed there.
    it.skipIf(bun)("serves CommonJS `.ts` (package without `type`) and `.cts`", async () => {
      runner = create({
        ...cjsOptions,
        name: "plugins-cjs",
        data: { entry: fixture("app-cjs.ts"), plugins },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["lib", "cts"]);
    });

    // `vendor/plain.ts` would become "hi" if the greeting plugin ran on it.
    it("scopes a plugin with an `id` filter from its options (glob exclude)", async () => {
      runner = create({
        ...cjsOptions,
        name: "plugins-exclude",
        data: {
          entry: fixture("app-vendor.ts"),
          plugins: [oxcEntry, [fixture("greeting.mjs"), { id: { exclude: "**/vendor/**" } }]],
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "vendor"]);
    });

    it("scopes a plugin with an `id` RegExp include", async () => {
      runner = create({
        ...cjsOptions,
        name: "plugins-include",
        data: {
          entry: fixture("app-vendor.ts"),
          plugins: [oxcEntry, fixture("greeting-include.mjs")],
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "vendor"]);
    });
  });
}

describe("plugins options", () => {
  it("rejects non-specifier plugins and non-serializable options", () => {
    // Server plugins (functions/objects) are a likely mix-up with the app entry's `plugins`.
    for (const plugin of [() => "", { name: "srvx-plugin", request() {} }]) {
      expect(() => normalizePluginEntries([plugin as any])).toThrow(
        /`data\.plugins\[0\]` must be a module specifier .* srvx server plugins belong on the app entry's `plugins`/,
      );
    }
    expect(
      () =>
        new NodeWorkerEnvRunner({
          name: "bad",
          data: { entry: fixture("app.tsx"), plugins: [{} as any] },
        }),
    ).toThrow(/module specifier/);
    expect(() => normalizePluginEntries("oxc" as any)).toThrow(/`data\.plugins` must be an array/);
    expect(() => normalizePluginEntries([[oxc, { re: /x/ }]])).toThrow(
      /`plugins\[0\] options\.re` must be JSON-serializable/,
    );
    expect(() => normalizePluginEntries([[oxc, { fn() {} }]])).toThrow(/JSON-serializable/);
    expect(normalizePluginEntries([[oxc, { a: [1, { b: null }] }]])).toBeTruthy();
    // Paths fail on the host, not as an import error inside the worker.
    expect(() => normalizePluginEntries(["./missing-plugin.mjs"])).toThrow(
      /`data\.plugins\[0\]` "\.\/missing-plugin\.mjs" does not resolve from /,
    );
  });

  it("does nothing without plugins", async () => {
    expect(await loadPlugins([])).toBeUndefined();
    expect(await loadPlugins(undefined)).toBeUndefined();
  });

  it("only runs script modules outside node_modules", async () => {
    const pipeline = (await loadPlugins([fixture("greeting.mjs")]))!;
    for (const ext of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]) {
      expect(pipeline.filter(`/app/src/index${ext}`)).toBe(true);
    }
    expect(pipeline.filter("/app/src/index.ts?v=1")).toBe(true);
    expect(pipeline.filter("/app/src/data.json")).toBe(false);
    expect(pipeline.filter("/app/node_modules/pkg/index.ts")).toBe(false);
    expect(pipeline.filter(String.raw`C:\app\node_modules\pkg\index.ts`)).toBe(false);
    // Virtual modules: by their format's module type.
    expect(pipeline.filter("#virtual", "js")).toBe(true);
    expect(pipeline.filter("/app/node_modules/#virtual", "js")).toBe(false);
  });

  it("prefilters by the plugins' `id` and `moduleType` filters", async () => {
    const pipeline = (await loadPlugins([oxc, fixture("greeting-include.mjs")]))!;
    // oxc: TypeScript/JSX only.
    expect(pipeline.filter("/app/a.ts")).toBe(true);
    expect(pipeline.filter("/app/a.jsx")).toBe(true);
    expect(pipeline.filter("/app/a.js")).toBe(false);
    // greeting-include: its `id` RegExp (case-insensitive), any module type.
    expect(pipeline.filter("/app/plugins/app-vendor.ts")).toBe(true);
    expect(pipeline.filter("/app/Plugins/cjs/dep.cts")).toBe(true);
    expect(pipeline.filter("/app/plugins/vendor/plain.js")).toBe(false);
    expect(pipeline.filter(String.raw`C:\app\plugins\app-vendor.ts`)).toBe(true);
    expect(pipeline.filter("#view", "tsx")).toBe(true);
    expect(pipeline.filter("#view", "js")).toBe(false);
  });

  it("leaves modules no plugin matches unread and untransformed", async () => {
    const calls: string[] = [];
    (globalThis as any).__pluginCalls = calls;
    // `order-pre.mjs` (no filter) would record every module it sees.
    const typed = (await loadPlugins([oxc]))!;
    expect(typed.filter("/app/a.mjs")).toBe(false);
    const module = { source: "export default 1;", format: "module" };
    expect(transformVirtualModule(typed, "#a", module)).toBe(module);
    const excluded = (await loadPlugins([
      [fixture("greeting.mjs"), { id: { exclude: "**/vendor/**" } }],
    ]))!;
    expect(excluded.filter("/app/vendor/a.ts")).toBe(false);
    expect(transformVirtualModule(excluded, "/app/vendor/a.js", "__GREETING__")).toBe(
      "__GREETING__",
    );
    expect(transformVirtualModule(excluded, "/app/a.js", "__GREETING__")).toEqual({
      source: '"hi"',
      format: "module",
    });
    const counted = (await loadPlugins([oxc, fixture("order-pre.mjs")]))!;
    expect(transformVirtualModule(counted, "/app/node_modules/a.ts", "a")).toBe("a");
    expect(calls).toEqual([]);
  });

  it("keeps a plugin off paths its `id` option excludes", async () => {
    const pipeline = (await loadPlugins([[oxc, { id: { exclude: "**/vendor/**" } }]]))!;
    expect(pipeline.filter("/app/src/a.ts")).toBe(true);
    expect(pipeline.filter("/app/vendor/a.ts")).toBe(false);
    expect(pipeline.transform("/app/vendor/a.ts", "enum A { B }")).toBeUndefined();
  });

  it("leaves plain JavaScript to oxc's `moduleType` filter", async () => {
    const pipeline = (await loadPlugins([oxc]))!;
    // Only reached through another plugin's filter, and still untouched.
    expect(pipeline.transform("/app/a.js", "const a = <div />;")).toBeUndefined();
    expect(pipeline.transform("/app/a.jsx", "const a = <div />;")).not.toContain("<div");
  });

  it("reports oxc errors with the file id", async () => {
    const pipeline = (await loadPlugins([oxc]))!;
    expect(() => pipeline.transform("/app/bad.tsx", "const a = <div>;")).toThrow(
      /failed to transform "\/app\/bad.tsx"/,
    );
  });

  it("inlines a source map for the original file", async () => {
    const pipeline = (await loadPlugins([oxc]))!;
    const map = decodeMap(pipeline.transform("/app/a.ts", "enum A { B }")!);
    expect(map.sources).toEqual(["file:///app/a.ts"]);
  });

  it("drops a second source map (maps aren't composed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pipeline = (await loadPlugins([oxc, fixture("mapped.mjs")]))!;
      expect(pipeline.transform("/app/a.ts", "enum A { B }")).not.toContain("sourceMappingURL");
      pipeline.transform("/app/b.ts", "enum B { C }");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/plugins "oxc" and ".+" both returned a source map/);
    } finally {
      warn.mockRestore();
    }
    // Alone, the plugin's map is relative to the original source.
    const own = (await loadPlugins([fixture("mapped.mjs")]))!;
    expect(decodeMap(own.transform("/app/a.js", "a()")!).mappings).toBe("AAAA");
  });

  it("orders plugins: pre → unordered (list order) → post", async () => {
    const calls: string[] = [];
    (globalThis as any).__pluginCalls = calls;
    const pipeline = (await loadPlugins([
      fixture("order-post.mjs"),
      oxc,
      fixture("order-fn.mjs"),
      fixture("order-pre.mjs"),
    ]))!;
    pipeline.transform("/app/a.ts", "const a: number = 1;");
    // oxc (unordered, listed first) returned `moduleType: "js"`.
    expect(calls).toEqual(["pre:ts:typed", "normal:js:untyped", "post:js:untyped"]);
  });

  it("passes untouched code through and rejects code left non-JS", async () => {
    const pipeline = (await loadPlugins([fixture("greeting.mjs")]))!;
    // No plugin changed it: served as if unmatched.
    expect(pipeline.transform("/app/a.ts", "const a: string = 1;")).toBeUndefined();
    // Changed but still TypeScript (nothing compiled it).
    expect(() => pipeline.transform("/app/a.ts", "const a: string = __GREETING__;")).toThrow(
      /still ts after its plugins/,
    );
    const js = (await loadPlugins([[fixture("greeting.mjs"), { greeting: "yo" }]]))!;
    expect(js.transform("/app/a.js", "const a = __GREETING__;")).toBe('const a = "yo";');
  });

  it("applies hook filters (id, code, moduleType, include/exclude)", async () => {
    const matches = async (filter: any, id: string, code = "", moduleType = "ts") =>
      (await resolvePlugin({ transform: { filter, handler: () => {} } }, "t", undefined)).matches(
        id,
        code,
        moduleType,
      );
    // Plain values include; exclude wins over include.
    expect(await matches({ id: /\.ts$/ }, "/app/a.ts")).toBe(true);
    expect(await matches({ id: [/\.tsx$/, "**/*.ts"] }, "/app/a.ts")).toBe(true);
    expect(
      await matches({ id: { include: "**/src/**", exclude: /skip/ } }, "/app/src/skip.ts"),
    ).toBe(false);
    expect(await matches({ id: { exclude: "**/vendor/**" } }, "/app/src/a.ts")).toBe(true);
    // Relative globs resolve from cwd.
    expect(await matches({ id: "src/**" }, `${process.cwd()}/src/a.ts`)).toBe(true);
    expect(await matches({ id: "src/**" }, "/elsewhere/src/a.ts")).toBe(false);
    // `code` strings are substrings; all properties must match.
    expect(await matches({ code: "import.meta.env" }, "/a.ts", "x(import.meta.env.X)")).toBe(true);
    expect(
      await matches({ code: "import.meta.env", id: /\.tsx$/ }, "/a.ts", "import.meta.env"),
    ).toBe(false);
    expect(await matches({ moduleType: ["tsx"] }, "/a.tsx", "", "tsx")).toBe(true);
    expect(await matches({ moduleType: { include: ["ts"] } }, "/a.tsx", "", "tsx")).toBe(false);
    // Stateful RegExps don't alternate.
    const g = /a/g;
    expect([
      await matches({ code: g }, "/a.ts", "a"),
      await matches({ code: g }, "/a.ts", "a"),
    ]).toEqual([true, true]);
  });

  it("calls factories with the options and passes them to hooks", async () => {
    const factory = await resolvePlugin(
      async (options: any) => ({ transform: (code: string) => code + options.suffix }),
      "f",
      { suffix: "!" },
    );
    expect(factory.handler("a", "/a.js", "js")).toBe("a!");
    const object = await resolvePlugin(
      { transform: (code: string, _id: string, meta: any) => code + meta.options.suffix },
      "o",
      { suffix: "?" },
    );
    expect(object.handler("a", "/a.js", "js")).toBe("a?");
  });

  it("warns once per plugin about hooks other than `transform`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugin = {
        name: "multi-hook",
        transform: (code: string) => code,
        load() {},
        resolveId: { handler() {} },
        buildStart: undefined,
      };
      await resolvePlugin(plugin, "x", undefined);
      await resolvePlugin(plugin, "x", undefined);
      await resolvePlugin({ name: "single-hook", transform: (code: string) => code }, "y", {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(
        /plugin "multi-hook": only the `transform` hook is supported; ignoring `load`, `resolveId`/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("builds Bun's `onLoad` filter from the plugins' filters", async () => {
    const plugin = (filter?: any) =>
      resolvePlugin({ transform: filter ? { filter, handler() {} } : () => {} }, "p", undefined);
    const test = (re: RegExp, paths: string[]) => paths.filter((path) => re.test(path));
    const paths = [
      "/app/a.js",
      "/app/a.mjs",
      "/app/a.cjs",
      "/app/a.ts",
      "/app/a.mts",
      "/app/a.cts",
      "/app/a.jsx",
      "/app/a.tsx",
      "/app/a.json",
      "/app/node_modules/pkg/a.ts",
      String.raw`C:\app\node_modules\pkg\a.ts`,
      String.raw`C:\app\src\a.ts`,
    ];

    // oxc alone: TypeScript/JSX extensions only, never CommonJS or node_modules.
    const oxcOnly = createBunFilter((await loadPlugins([oxc]))!.plugins);
    expect(test(oxcOnly, paths)).toEqual([
      "/app/a.ts",
      "/app/a.mts",
      "/app/a.jsx",
      "/app/a.tsx",
      String.raw`C:\app\src\a.ts`,
    ]);
    // A plugin without a `moduleType` filter adds every non-CommonJS extension.
    const all = createBunFilter([await plugin()]);
    expect(test(all, paths)).toEqual([
      "/app/a.js",
      "/app/a.mjs",
      "/app/a.ts",
      "/app/a.mts",
      "/app/a.jsx",
      "/app/a.tsx",
      String.raw`C:\app\src\a.ts`,
    ]);
    expect(test(createBunFilter([await plugin({ moduleType: ["js"] })]), paths)).toEqual([
      "/app/a.js",
      "/app/a.mjs",
    ]);

    // One alternative per plugin: its extensions, RegExp excludes and includes.
    const exact = createBunFilter([
      await plugin({ id: /\/SRC\//i, moduleType: ["ts"] }),
      await plugin({ id: { include: [/\/lib\//gi], exclude: /skip/i }, moduleType: ["tsx"] }),
    ]);
    expect(exact.flags).toBe("i");
    expect(
      test(exact, [
        "/app/src/a.ts",
        "/app/lib/a.tsx",
        "/app/lib/a.ts",
        "/app/src/a.tsx",
        "/app/lib/skip.tsx",
        "/app/a.ts",
        "/app/node_modules/src/a.ts",
      ]),
    ).toEqual(["/app/src/a.ts", "/app/lib/a.tsx"]);
    const bun = async (...filters: any[]) =>
      createBunFilter(await Promise.all(filters.map((filter) => plugin(filter))));
    // Exclude-only `id` filter.
    expect(
      test(await bun({ id: { exclude: /\/vendor\// } }), ["/app/vendor/a.ts", "/app/a.ts"]),
    ).toEqual(["/app/a.ts"]);
    // A glob include can't be folded: that plugin's alternative takes any path.
    const glob = await bun(
      { id: /\/src\//, moduleType: ["ts"] },
      { id: "**/lib/**", moduleType: ["tsx"] },
    );
    expect(test(glob, ["/app/src/a.ts", "/app/other/a.ts", "/app/other/a.tsx"])).toEqual([
      "/app/src/a.ts",
      "/app/other/a.tsx",
    ]);
    // A glob exclude is left to the JS filter; RegExp includes still apply.
    const globExclude = await bun({ id: { include: /\/src\//, exclude: "**/skip/**" } });
    expect(test(globExclude, ["/app/src/skip/a.ts", "/app/lib/a.ts"])).toEqual([
      "/app/src/skip/a.ts",
    ]);
    // No `id` filter: that plugin's alternative takes any path.
    const noId = await bun({ id: /\/src\//, moduleType: ["ts"] }, { moduleType: ["tsx"] });
    expect(test(noId, ["/app/other/a.ts", "/app/other/a.tsx"])).toEqual(["/app/other/a.tsx"]);
    // Differing flags: no `id` filter is folded in.
    const mixed = await bun({ id: /\/src\//i }, { id: /\/lib\// });
    expect(mixed.flags).toBe("");
    expect(mixed.test("/app/other/a.ts")).toBe(true);
    // Group names and numbers don't survive joining sources: no `id` folding.
    const grouped = await bun({ id: /(?<dir>src)\// }, { id: /(?<dir>lib)\// });
    expect(grouped.test("/app/other/a.ts")).toBe(true);
    const backref = await bun({ id: /(a)\1/ }, { id: /\/(src)\// });
    expect(backref.test("/app/other/a.ts")).toBe(true);
    // A custom module type implies no extension.
    expect(test(await bun({ moduleType: ["svelte"] }), paths)).toEqual([]);
  });

  it("gives handlers a context to warn and throw with", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugin = await resolvePlugin(
        {
          name: "ctx",
          transform(this: any, code: string) {
            if (code === "throw") {
              this.error(new Error("bad code"));
            }
            this.warn("careful");
          },
        },
        "x",
        undefined,
      );
      plugin.handler("ok", "/app/a.ts", "ts");
      expect(warn).toHaveBeenCalledWith('[env-runner] plugin "ctx" (/app/a.ts): careful');
      let error: any;
      try {
        plugin.handler("throw", "/app/a.ts", "ts");
      } catch (error_) {
        error = error_;
      }
      expect(error.message).toBe('[env-runner] plugin "ctx" (/app/a.ts): bad code');
      expect(error.cause.message).toBe("bad code");
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects invalid plugin exports and async handlers", async () => {
    await expect(resolvePlugin(undefined, "x", undefined)).rejects.toThrow(
      /no usable default export/,
    );
    await expect(resolvePlugin({ name: "x" }, "x", undefined)).rejects.toThrow(/transform/);
    await expect(
      resolvePlugin({ transform: { order: "early", handler() {} } }, "x", undefined),
    ).rejects.toThrow(/order/);
    await expect(resolvePlugin(() => "nope", "x", undefined)).rejects.toThrow(
      /factory that didn't return a plugin object/,
    );
    await expect(
      resolvePlugin(
        () => {
          throw new Error("boom");
        },
        "x",
        undefined,
      ),
    ).rejects.toThrow(/plugin "x" failed to initialize: boom/);
    const pipeline = (await loadPlugins([fixture("async.mjs")]))!;
    expect(() => pipeline.transform("/app/a.ts", "a")).toThrow(/synchronous/);
  });
});

function decodeMap(code: string) {
  const match = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(code);
  expect(match).toBeTruthy();
  return JSON.parse(Buffer.from(match![1]!, "base64").toString());
}
