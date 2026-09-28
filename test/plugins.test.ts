import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { transformSync } from "oxc-transform";

import type {
  EnvRunner,
  EnvRunnerPlugin,
  PluginContext,
  PluginTransformHandler,
} from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";
import { EnvServer } from "../src/server.ts";
import { RunnerManager } from "../src/manager.ts";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import { createPluginPipeline, transformVirtualModules } from "../src/plugin/pipeline.ts";
import {
  createPrefilter,
  moduleTypeOf,
  restoreInternalQuery,
  stripInternalQuery,
} from "../src/plugin/filter.ts";
import { globToRegExp, resolveGlob } from "../src/plugin/glob.ts";
import { openTransformSocket } from "../src/plugin/channel.ts";
import { connect } from "node:net";
import {
  createBunFilter,
  createBunResolveFilter,
  resolveSchemes,
  transformedFormat,
} from "../src/plugin/hooks.ts";

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

// `resolveId`/`load` plugins: `virtual:` modules (one importing another, one
// loaded as TypeScript for the oxc plugin), an alias to a file, a `.yaml` file
// and a JSON module. Records `[source, importer]` of resolved imports.
function resolvers(seen: [string, string | undefined][]): EnvRunnerPlugin[] {
  return [
    {
      name: "virtual",
      resolveId: {
        filter: { id: /^virtual:/ },
        handler(source, importer) {
          seen.push([source, importer]);
          return `\0${source}`;
        },
      },
      load: {
        filter: { id: /^\0virtual:/ },
        async handler(id) {
          await new Promise((r) => setTimeout(r, 1));
          if (id === "\0virtual:message") {
            return 'import suffix from "virtual:suffix"; export default "hello" + suffix;';
          }
          if (id === "\0virtual:suffix") {
            return { code: 'export default "!" as string;', moduleType: "ts" };
          }
        },
      },
    },
    {
      name: "alias",
      resolveId: {
        filter: { id: "@alias/**" },
        handler: async (source) => fixture(source.slice("@alias/".length)),
      },
    },
    {
      name: "yaml",
      transform: {
        filter: { id: /\.yaml$/ },
        handler(code) {
          // Fixtures may be checked out with CRLF (Windows).
          const entries = code
            .trim()
            .split(/\r?\n/)
            .map((line) => line.split(": "));
          return `export default ${JSON.stringify(Object.fromEntries(entries))};`;
        },
      },
    },
    {
      name: "json",
      transform: {
        filter: { moduleType: ["json"], id: "**/plugins/data.json" },
        handler: (code) => JSON.stringify({ ...JSON.parse(code), patched: true }),
      },
    },
  ];
}

// Query plugins, recording `[hook, id]` pairs: `?raw` imports loaded as their
// source by a `load` hook, `?lines` modules (read from disk without the query)
// transformed into their line count.
function queries(seen: [string, string][]): EnvRunnerPlugin[] {
  const has = (key: string) => [
    { kind: "include" as const, expr: { kind: "query" as const, key, pattern: true } },
  ];
  return [
    {
      name: "raw",
      load: {
        filter: has("raw"),
        handler(id) {
          seen.push(["load", id]);
          const code = readFileSync(id.slice(0, id.indexOf("?")), "utf8");
          return { code: `export default ${JSON.stringify(code)};`, moduleType: "js" };
        },
      },
    },
    {
      name: "lines",
      transform: {
        order: "pre",
        filter: has("lines"),
        handler(code, id) {
          seen.push(["transform", id]);
          return { code: `export default ${code.trim().split("\n").length};`, moduleType: "js" };
        },
      },
    },
  ];
}

// `.wasm` as an ES module instantiating it, with its exports as named
// exports. The bytes are inlined, or (`native`, for workerd, which can't
// compile bytes) the file is imported as a compiled module (`?module`, which
// the filter leaves out).
function wasm(options: { native?: boolean } = {}): EnvRunnerPlugin {
  return {
    name: "wasm",
    load: {
      filter: { id: /\.wasm$/ },
      handler(id) {
        const bytes = readFileSync(id);
        const names = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(
          (entry) => entry.name,
        );
        return [
          options.native
            ? `import module from ${JSON.stringify(`${id}?module`)};`
            : `const module = new WebAssembly.Module(Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (c) => c.charCodeAt(0)));`,
          "const { exports } = new WebAssembly.Instance(module);",
          ...names.map((name) => `export const ${name} = exports.${name};`),
        ].join("\n");
      },
    },
  };
}

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
        plugins: [oxc(), greeting({ seen })],
        data: { entry: fixture("app.tsx") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(expected);
      // The handler ran in this process, with the file path as id.
      expect(seen).toEqual([fixture("app.tsx")]);
    });

    it("resolves and loads modules with `resolveId`/`load` hooks", async () => {
      const seen: [string, string | undefined][] = [];
      runner = create({
        name: "plugins-resolve",
        plugins: [oxc(), resolvers(seen)],
        data: { entry: fixture("app-resolve.ts") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({
        message: "hello!",
        aliased: "aliased",
        yaml: { name: "env-runner", kind: "yaml" },
        json: { name: "data", patched: true },
        jsonName: "data",
      });
      expect(seen).toEqual([
        ["virtual:message", fixture("app-resolve.ts")],
        ["virtual:suffix", "\0virtual:message"],
      ]);
    });

    it.runIf(name === "BunProcessEnvRunner")(
      "leaves other files no plugin changes to Bun, even when a filter names them",
      async () => {
        const seen: string[] = [];
        const all: EnvRunnerPlugin = {
          name: "all",
          transform: {
            filter: { id: "**/fixtures/plugins/**" },
            handler: (_code, id) => void seen.push(id.split(/[\\/]/).pop()!),
          },
        };
        runner = create({
          name: "plugins-files",
          plugins: [resolvers([]), all],
          data: { entry: fixture("app-files.ts") },
        });
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual({
          note: "hello",
          logo: "logo.svg",
          yaml: { name: "env-runner", kind: "yaml" },
        });
        expect(seen).toEqual(expect.arrayContaining(["app-files.ts", "note.txt", "logo.svg"]));
      },
    );

    it("passes ids with their import query, without env-runner's own params", async () => {
      const seen: [string, string][] = [];
      // Every script module the plugins see (before the others change it).
      const ids: string[] = [];
      const record: EnvRunnerPlugin = {
        name: "record",
        transform: { order: "pre", handler: (_code, id) => void ids.push(id) },
      };
      runner = create({
        name: "plugins-query",
        plugins: [record, oxc(), queries(seen)],
        data: {
          entry: fixture("app-query.ts"),
          virtual: { "#stamp": "export default 1;" },
        },
      });
      await runner.waitForReady();
      const source = readFileSync(fixture("dep.ts"), "utf8");
      const body = {
        note: "hello",
        depSource: true,
        depLines: source.trim().split("\n").length,
        label: "Ok",
        separate: true,
        dynamic: true,
        // CommonJS output with a query (miniflare: behind its ESM shim).
        cjs: "lib",
        stamp: 1,
      };
      expect(await (await runner.fetch("http://localhost/")).json()).toEqual(body);
      const note = fixture("note.txt?raw");
      const depRaw = fixture("dep.ts?raw");
      expect(seen).toEqual([
        ["load", note],
        ["load", depRaw],
        ["transform", fixture("dep.ts?lines")],
      ]);
      // The importer (with its version and a reload's param) is re-served
      // under its own id.
      await runner.updateVirtualModules!({ "#stamp": "export default 2;" });
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
        ...body,
        stamp: 2,
      });
      const entry = fixture("app-query.ts");
      expect(ids.filter((id) => id.startsWith(entry))).toEqual([entry, entry]);
      const internal = /__env|__cjs|[?&][tv]=/;
      expect(ids.filter((id) => internal.test(id))).toEqual([]);
      expect(seen.filter(([, id]) => internal.test(id))).toEqual([]);
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
        plugins: [oxc(), pre],
        data: { entry: fixture("app.tsx") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual({ ...expected, children: ["Ok", "hey from tsx"] });
    });

    it("sends node_modules files only to filters naming them (with `code`), or paths `resolveId` returned", async () => {
      const dir = mkdtempSync(join(tmpdir(), "env-runner-plugins-"));
      const write = (path: string, code: string) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), code);
      };
      for (const pkg of ["named", "other", "resolved"]) {
        write(`node_modules/${pkg}/index.mjs`, 'export const value = "__V__";');
      }
      // `import.meta` replaced in a package's runtime files only.
      const meta = 'export const dev = import.meta.dev ?? "unset";';
      write("node_modules/nitro/dist/runtime/meta.mjs", meta);
      write("node_modules/nitro/dist/other/meta.mjs", meta);
      write(
        "app.mjs",
        `import { value as named } from "./node_modules/named/index.mjs";
        import { value as other } from "./node_modules/other/index.mjs";
        import { value as resolved } from "#resolved.mjs";
        import { dev as runtimeDev } from "./node_modules/nitro/dist/runtime/meta.mjs";
        import { dev as otherDev } from "./node_modules/nitro/dist/other/meta.mjs";
        export default {
          fetch: () => Response.json({ named, other, resolved, runtimeDev, otherDev }),
        };`,
      );
      runner = create({
        name: "plugins-node-modules",
        plugins: [
          {
            name: "named",
            transform: {
              filter: { id: "**/node_modules/named/**" },
              handler: (code: string) => code.replace("__V__", "named"),
            },
          },
          {
            name: "alias",
            resolveId: {
              filter: { id: /^#resolved\.mjs$/ },
              handler: () => join(dir, "node_modules/resolved/index.mjs"),
            },
          },
          // Unfiltered: only gets the resolved path.
          { name: "any", transform: (code: string) => code.replace("__V__", "any") },
          {
            name: "import-meta",
            transform: {
              filter: { id: "**/node_modules/nitro/dist/runtime/**", code: "import.meta." },
              handler: (code: string) => code.replaceAll("import.meta.dev", "true"),
            },
          },
        ],
        data: { entry: join(dir, "app.mjs") },
      });
      try {
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual({
          named: "named",
          other: "__V__",
          resolved: "any",
          runtimeDev: true,
          otherDev: "unset",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("re-transforms the entry on reloadModule()", async () => {
      const dir = mkdtempSync(join(tmpdir(), "env-runner-plugins-"));
      cpSync(resolve(_dir, "fixtures/plugins"), dir, { recursive: true });
      const entry = join(dir, "app.tsx");
      runner = create({
        name: "plugins-reload",
        plugins: [oxc(), greeting()],
        data: { entry },
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
        plugins: [oxc(), greeting()],
        data: {
          entry: "#entry.tsx",
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
        plugins: [failing, oxc()],
        data: { entry: fixture("app.tsx") },
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
        plugins: [oxc()],
        data: {
          entry: "#entry.ts",
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
        plugins: [oxc(), greeting({ id: "**/cjs/**" })],
        data: { entry: fixture("app-cjs.ts") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["lib", "cts", "plain"]);
    });

    it("leaves TypeScript no plugin compiled to the runtime", async () => {
      runner = create({
        name: "plugins-typed",
        plugins: [greeting()],
        data: { entry: fixture("typed.ts") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hi");
    });

    it("serves a virtual path key over the file plugins would transform", async () => {
      runner = create({
        ...cjsOptions,
        name: "plugins-virtual-path",
        plugins: [oxc(), greeting()],
        data: {
          entry: fixture("app-vendor.ts"),
          virtual: { [fixture("vendor/plain.ts")]: `export const value: string = "virtual";` },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["cts", "virtual"]);
    });

    it("serves a virtual path key without a file that `resolveId` resolved to", async () => {
      // No file on disk: only the virtual module (transformed on the host).
      const key = fixture("virtual-key/value.mjs");
      runner = create({
        name: "plugins-virtual-key",
        plugins: [
          {
            name: "alias",
            resolveId: {
              filter: { id: /^#virtual-key\// },
              handler: (source: string) => fixture(`virtual-key/${source.slice(13)}`),
            },
          },
          greeting(),
        ],
        data: {
          entry: fixture("app-virtual-key.ts"),
          virtual: { [key]: `export default __GREETING__;` },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hi");
    });

    it("resolves only imports the runtime can't with `fallback` hooks", async () => {
      const seen: string[] = [];
      runner = create({
        name: "plugins-fallback",
        plugins: [
          {
            name: "extensionless",
            resolveId: {
              fallback: true,
              filter: { id: /^\.\.?\// },
              handler(source: string, importer: string | undefined) {
                seen.push(source);
                const path = join(dirname(importer!), `${source}.mjs`);
                return existsSync(path) ? path : null;
              },
            },
          },
        ],
        data: { entry: fixture("app-fallback.mjs") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["utils", "native"]);
      // Bun resolves extensionless imports itself.
      expect(seen).toEqual(name === "BunProcessEnvRunner" ? [] : ["./fallback/utils"]);
    });

    it("loads `.wasm` as an ES module wrapper from a `load` hook", async () => {
      runner = create({
        name: "plugins-wasm",
        plugins: [wasm({ native: miniflareRunner })],
        data: { entry: fixture("app-wasm.ts") },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("5");
    });

    // `vendor/plain.ts` would become "hi" if the greeting plugin ran on it.
    it("scopes a plugin with `id` filters (glob exclude, RegExp include)", async () => {
      for (const id of [{ exclude: "**/vendor/**" }, /Plugins[/\\](?:app-vendor|cjs)/i]) {
        runner = create({
          ...cjsOptions,
          name: "plugins-id",
          plugins: [oxc(), { ...greeting({ id }), name: "greeting" }],
          data: {
            entry: fixture("app-vendor.ts"),
          },
        });
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.json()).toEqual(["cts", "vendor"]);
        await runner.close();
      }
    });

    it("scopes a plugin with filter expressions, into dot directories", async () => {
      const seen: string[] = [];
      const { handler } = greeting({ seen }).transform as { handler: PluginTransformHandler };
      runner = create({
        name: "plugins-expressions",
        plugins: [
          oxc(),
          {
            name: "greeting",
            transform: {
              filter: [
                { kind: "exclude", expr: { kind: "id", pattern: "**/vendor/**" } },
                {
                  kind: "include",
                  expr: {
                    kind: "and",
                    args: [
                      { kind: "id", pattern: "**/*.ts" },
                      { kind: "code", pattern: "__GREETING__" },
                    ],
                  },
                },
              ],
              handler,
            },
          },
        ],
        data: {
          entry: fixture("app-dot.ts"),
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.json()).toEqual(["hi", "vendor"]);
      expect(seen).toEqual([fixture(".hidden/value.ts")]);
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
        plugins: [greeting({ greeting: value })],
        data: { entry: fixture("typed.ts") },
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

describe("EnvServer plugins", () => {
  it("passes `plugins` to the runners it creates", async () => {
    const server = new EnvServer({ entry: fixture("app.tsx"), plugins: [oxc(), greeting()] });
    try {
      const res = await server.fetch(new Request("http://localhost/"));
      expect(await res.json()).toEqual(expected);
    } finally {
      await server.close();
    }
  });
});

describe("plugins", () => {
  it("validates `plugins`", () => {
    expect(createPluginPipeline(undefined)).toBeUndefined();
    expect(createPluginPipeline(null as any)).toBeUndefined();
    expect(() =>
      createPluginPipeline([{ transform: { filter: { moduleType: "ts" as any }, handler() {} } }]),
    ).toThrow(/invalid `transform\.filter\.moduleType`/);
    expect(() => createPluginPipeline("oxc" as any)).toThrow(/must be an array/);
    // Other hooks are ignored: a plugin may have none of these. Without any
    // supported hook, as without `plugins`.
    expect(createPluginPipeline([{ name: "other", buildStart() {} } as any])).toBeUndefined();
    expect(createPluginPipeline([])).toBeUndefined();
    expect(createPluginPipeline([false, null, [[]]])).toBeUndefined();
    expect(() => createPluginPipeline([false, [{ transform: 1 } as any]])).toThrow(
      /`plugins\[1\]\[0\]` has an invalid `transform` hook/,
    );
    expect(() => createPluginPipeline([{ transform: 1 } as any])).toThrow(
      /`plugins\[0\]` has an invalid `transform` hook \(got 1\)/,
    );
    expect(() => createPluginPipeline([{ load: {} } as any])).toThrow(/invalid `load` hook/);
    expect(() =>
      createPluginPipeline([{ load: { filter: { code: "x" }, handler() {} } } as any]),
    ).toThrow(/invalid `load\.filter\.code` \(`load` filters take `id` only\)/);
    expect(() =>
      createPluginPipeline([
        {
          resolveId: {
            filter: [{ kind: "include", expr: { kind: "moduleType", pattern: "js" } }],
            handler() {},
          },
        },
      ]),
    ).toThrow(/`moduleType` doesn't apply to `resolveId`/);
    expect(() => createPluginPipeline([(() => {}) as any])).toThrow(/is not a plugin object/);
    expect(() =>
      createPluginPipeline([{ transform: { order: "first", handler() {} } } as any]),
    ).toThrow(/invalid `transform\.order`/);
    expect(
      () =>
        new NodeWorkerEnvRunner({
          name: "bad",
          plugins: [{ transform: "x" } as any],
          data: { entry: fixture("app.tsx") },
        }),
    ).toThrow(/`plugins\[0\]`/);
  });

  it("closes the self runner", async () => {
    const runner = new SelfEnvRunner({
      name: "self",
      plugins: [oxc()],
      data: { entry: fixture("app.tsx") },
    });
    await expect(runner.waitForReady()).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/Cannot use plugins: the self runner does not support them/),
      },
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
      greeting({ id: /plugins[/\\]app/giy }),
    ])!;
    // Serializable: RegExps as source and flags (without `g`/`y`), globs
    // compiled.
    const prefilters = JSON.parse(JSON.stringify(pipeline.prefilters));
    expect(prefilters).toEqual([
      {
        id: { include: [], exclude: [{ source: expect.any(String), flags: "", glob: true }] },
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
      sources: [pathToFileURL("/app/a.ts").href],
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
    ).rejects.toThrow(/non-string `code` for "\/a\.js" \(got 1\): convert it to a string/);
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
    const filter = (prefilters: any[]) => createBunFilter(prefilters, false);
    const all = filter([{}]);
    expect(all.test("/app/a.ts")).toBe(true);
    expect(all.test("/app/a.cts")).toBe(false);
    expect(all.test("/app/node_modules/x/a.ts")).toBe(false);
    expect(all.test(String.raw`C:\app\node_modules\x\a.ts`)).toBe(false);
    // With the import's query, but not under a Bun marker (their own `onLoad`).
    expect(all.test("/app/a.ts?raw")).toBe(true);
    expect(all.test("/app/a.ts?x=/node_modules/")).toBe(true);
    expect(all.test("/app/a.txt?x.ts")).toBe(false);
    expect(all.test("/app/a.ts?__env_runner_virtual")).toBe(false);
    expect(all.test("/app/a.ts?__env_runner_disk&raw&v=2")).toBe(false);
    expect(all.test("/app/a.ts?__env_runner_plugin&raw")).toBe(false);
    expect(all.test("/app/a.ts?raw&__env_runner_plugin")).toBe(true);
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
    // Compiled globs are folded too, matching either separator.
    const [globbed] = createPluginPipeline([
      {
        transform: {
          filter: { id: { include: "/app/src/**", exclude: "**/gen/**" } },
          handler() {},
        },
      },
    ])!.prefilters;
    const globs = filter([globbed]);
    expect(globs.test("/app/src/a.ts")).toBe(true);
    expect(globs.test(String.raw`\app\src\a.ts`)).toBe(true);
    expect(globs.test("/app/src/gen/a.ts")).toBe(false);
    expect(globs.test("/x/a.ts")).toBe(false);
    // RegExps are written for `/`: not folded where paths use `\`.
    const regExpScoped = [{ id: { include: [{ source: "src", flags: "" }], exclude: [] } }];
    expect(createBunFilter(regExpScoped, true).test("/x/a.ts")).toBe(true);
    expect(createBunFilter([globbed!], true).test("/x/a.ts")).toBe(false);
    // Filter expressions: extension branches only.
    const expressions = filter([
      { expr: [{ kind: "include", expr: { kind: "moduleType", pattern: "tsx" } }] },
    ]);
    expect(expressions.test("/x/a.ts")).toBe(true);
    expect(expressions.test("/x/a.cts")).toBe(false);
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

describe("plugin filters", () => {
  const cwd = process.cwd().replaceAll("\\", "/");
  // The ids a plugin with this filter runs on (full filter, on the host).
  const matching = async (filter: any, ids: string[], code = "code") => {
    const seen: string[] = [];
    const pipeline = createPluginPipeline([
      { transform: { filter, handler: (_code, id) => void seen.push(id) } },
    ])!;
    for (const id of ids) {
      await pipeline.transform(id, code, "ts");
    }
    return seen;
  };

  it("escapes the working directory of relative globs", () => {
    for (const dir of ["/tmp/app[1]", "/tmp/app{a,b}", "/tmp/a*b?", String.raw`C:\work\app(1)`]) {
      const glob = resolveGlob("src/**", dir);
      const base = dir.replaceAll("\\", "/");
      expect(globToRegExp(glob).test(`${base}/src/a.ts`), dir).toBe(true);
      expect(globToRegExp(glob).test(`${base.replace(/[[{*?(]/, "x")}/src/a.ts`), dir).toBe(false);
    }
  });

  it("keeps `\\` escapes in absolute globs using `/` on Windows", () => {
    expect(resolveGlob(String.raw`/r/\[x\].ts`, "/", true)).toBe(String.raw`/r/\[x\].ts`);
    // `\` separators only: a Windows path.
    expect(resolveGlob(String.raw`C:\app\*.ts`, "/", true)).toBe("C:/app/*.ts");
    expect(resolveGlob(String.raw`C:/r/\*.ts`, "/", true)).toBe(String.raw`C:/r/\*.ts`);
    expect(resolveGlob(String.raw`/r/\[x\].ts`, "/", false)).toBe(String.raw`/r/\[x\].ts`);
  });

  it("matches globs with `*` and `**` into dot files and directories", async () => {
    const ids = ["/app/src/a.ts", "/app/.nitro/b.ts", "/app/src/.env.ts", "/app/src/A.TS"];
    expect(await matching({ id: "**/*.ts" }, ids)).toEqual(ids.slice(0, 3));
    expect(await matching({ id: "/app/src/*" }, ids)).toEqual([
      "/app/src/a.ts",
      "/app/src/.env.ts",
      "/app/src/A.TS",
    ]);
    expect(await matching({ id: { exclude: "**/.nitro/**" } }, ids)).toEqual([
      "/app/src/a.ts",
      "/app/src/.env.ts",
      "/app/src/A.TS",
    ]);
    // `src/**` needs something after `src/`; `**` within a segment is `*`.
    expect(await matching({ id: "/app/src/**" }, ["/app/src", "/app/src/x/a.ts"])).toEqual([
      "/app/src/x/a.ts",
    ]);
    expect(await matching({ id: "/app/**.ts" }, ["/app/a.ts", "/app/x/a.ts"])).toEqual([
      "/app/a.ts",
    ]);
  });

  it("resolves globs from cwd unless they start with `**` or are absolute", async () => {
    const ids = [`${cwd}/a.ts`, `${cwd}/src/b.ts`, "a.ts", "/elsewhere/a.ts"];
    expect(await matching({ id: "*.ts" }, ids)).toEqual([`${cwd}/a.ts`]);
    expect(await matching({ id: "./src/../src/*.ts" }, ids)).toEqual([`${cwd}/src/b.ts`]);
    expect(await matching({ id: "**/a.ts" }, ids)).toEqual([
      `${cwd}/a.ts`,
      "a.ts",
      "/elsewhere/a.ts",
    ]);
  });

  it("supports classes, braces and escapes, but no extglobs", async () => {
    const ids = ["/r/a.ts", "/r/b.ts", "/r/c.tsx", "/r/[x].ts", "/r/*.ts"];
    expect(await matching({ id: "/r/[!a*].ts" }, ids)).toEqual(["/r/b.ts"]);
    expect(await matching({ id: "/r/[^ab*].ts" }, ids)).toEqual([]);
    expect(await matching({ id: "/r/[a-b].ts" }, ids)).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(await matching({ id: "/r/{a,{b,c}}.{ts,tsx}" }, ids)).toEqual(ids.slice(0, 3));
    expect(await matching({ id: "/r/*.{ts}" }, ids)).toEqual([
      "/r/a.ts",
      "/r/b.ts",
      "/r/[x].ts",
      "/r/*.ts",
    ]);
    expect(await matching({ id: String.raw`/r/\[x\].ts` }, ids)).toEqual(["/r/[x].ts"]);
    expect(await matching({ id: String.raw`/r/\*.ts` }, ids)).toEqual(["/r/*.ts"]);
    expect(await matching({ id: "/r/+(a|b).ts" }, ids)).toEqual([]);
    expect(await matching({ id: "/r/{a.ts" }, ["/r/{a.ts", "/r/a.ts"])).toEqual(["/r/{a.ts"]);
  });

  it("matches ids with their query, `/`-separated, and RegExps without `g`/`y`", async () => {
    const seen = await matching({ id: /\/src\//y }, [
      "/app/src/a.ts?v=1",
      String.raw`C:\app\src\b.ts?x=\y`,
    ]);
    // Handlers get the ids as they are.
    expect(seen).toEqual(["/app/src/a.ts?v=1", String.raw`C:\app\src\b.ts?x=\y`]);
    // Globs and RegExps both see the query (only the path is `/`-separated).
    const ids = ["/app/a.ts", "/app/a.ts?raw", String.raw`C:\app\a.ts?x=\y`];
    expect(await matching({ id: /a\.ts\?raw$/ }, ids)).toEqual(["/app/a.ts?raw"]);
    expect(await matching({ id: /a\.ts$/ }, ids)).toEqual(["/app/a.ts"]);
    expect(await matching({ id: "/app/*.ts" }, ids)).toEqual(["/app/a.ts"]);
    expect(await matching({ id: "/app/*.ts{?*,}" }, ids)).toEqual(ids.slice(0, 2));
    expect(await matching({ id: /^C:\/app\/a\.ts\?x=\\y$/ }, ids)).toEqual([ids[2]]);
    expect(await matching({ id: { exclude: /\?raw$/ } }, ids)).toEqual([ids[0], ids[2]]);
    // The module type comes from the path.
    expect(moduleTypeOf("/app/a.svg?raw")).toBe("svg");
    expect(moduleTypeOf("/app/a.ts?x.json")).toBe("ts");
    const global = /a/g;
    expect(await matching({ id: global, code: global }, ["/a1.ts", "/a2.ts"], "a")).toEqual([
      "/a1.ts",
      "/a2.ts",
    ]);
    expect(global.flags).toBe("g");
  });

  it("ignores empty filter values and rejects invalid ones", async () => {
    const ids = ["/a.ts", "/b.ts"];
    for (const filter of [
      { id: "" },
      { id: null },
      { id: [] },
      { id: {} },
      { code: "" },
      {},
      null,
    ]) {
      expect(await matching(filter, ids)).toEqual(ids);
    }
    expect(await matching({ id: { include: [], exclude: "/b.ts" } }, ids)).toEqual(["/a.ts"]);
    const create = (filter: any) => () =>
      createPluginPipeline([{ name: "p", transform: { filter, handler() {} } }]);
    expect(create({ id: [1] })).toThrow(
      /`plugins\[0\]` has an invalid `transform\.filter\.id` \(got 1\): expected strings or RegExps/,
    );
    expect(create({ code: { exclude: [{}] } })).toThrow(
      /invalid `transform\.filter\.code` \(got an object\)/,
    );
    expect(create({ moduleType: [] })).toThrow(
      /invalid `transform\.filter\.moduleType` \(no module types\)/,
    );
    expect(create({ moduleType: { include: [] } })).toThrow(/no module types/);
    expect(create({ moduleType: ["ts", 1] })).toThrow(/invalid `transform\.filter\.moduleType`/);
    expect(create("**/*.ts")).toThrow(/invalid `transform\.filter` \(got "\*\*\/\*\.ts"\)/);
  });

  const include = (expr: any) => ({ kind: "include" as const, expr });
  const exclude = (expr: any) => ({ kind: "exclude" as const, expr });
  const id = (pattern: any) => ({ kind: "id", pattern });
  const code = (pattern: any) => ({ kind: "code", pattern });
  const moduleType = (pattern: any) => ({ kind: "moduleType", pattern });

  it("evaluates filter expressions: the first matching include or exclude decides", async () => {
    const ids = ["/app/a.ts", "/app/b.ts", "/app/vendor/c.ts"];
    expect(await matching([include(id(/a\.ts$/))], ids)).toEqual(["/app/a.ts"]);
    expect(await matching([exclude(id("**/vendor/**"))], ids)).toEqual(ids.slice(0, 2));
    expect(await matching([include(id("**/vendor/**")), exclude(id("**/*.ts"))], ids)).toEqual([
      "/app/vendor/c.ts",
    ]);
    expect(
      await matching(
        [include({ kind: "and", args: [moduleType("ts"), { kind: "not", expr: id(/b\.ts$/) }] })],
        ids,
      ),
    ).toEqual(["/app/a.ts", "/app/vendor/c.ts"]);
    expect(
      await matching([include({ kind: "or", args: [id(/a\.ts$/), code("MARK")] })], ids, "MARK"),
    ).toEqual(ids);
    expect(await matching([include(moduleType("tsx"))], ids)).toEqual([]);
    expect(await matching([], ids)).toEqual(ids);
  });

  it("matches `query` expressions against the id's query", async () => {
    const query = (key: string, pattern: any) => [include({ kind: "query", key, pattern })];
    const ids = ["/a.ts", "/a.ts?raw", "/a.ts?url=1&raw", "/a.ts?type=style&lang.css", "/a.ts#raw"];
    // A boolean: whether the key is present (with or without a value).
    expect(await matching(query("raw", true), ids)).toEqual(["/a.ts?raw", "/a.ts?url=1&raw"]);
    expect(await matching(query("raw", false), ids)).toEqual([
      "/a.ts",
      "/a.ts?type=style&lang.css",
      "/a.ts#raw",
    ]);
    // A string equals the value (`?raw` has `""`), a RegExp tests it (`""` when absent).
    expect(await matching(query("raw", ""), ids)).toEqual(["/a.ts?raw", "/a.ts?url=1&raw"]);
    expect(await matching(query("url", "1"), ids)).toEqual(["/a.ts?url=1&raw"]);
    expect(await matching(query("type", /^sty/), ids)).toEqual(["/a.ts?type=style&lang.css"]);
    // `g`/`y` flags are dropped: every test matches.
    expect(await matching(query("v", /a/gy), ["/a.ts?v=a", "/b.ts?v=a", "/c.ts?v=a"])).toEqual([
      "/a.ts?v=a",
      "/b.ts?v=a",
      "/c.ts?v=a",
    ]);
    expect(await matching(query("type", /^$/), ids)).toEqual([
      "/a.ts",
      "/a.ts?raw",
      "/a.ts?url=1&raw",
      "/a.ts#raw",
    ]);
    // Parsed like `URLSearchParams` (decoded), without the fragment.
    expect(await matching(query("q", "a b"), ["/a.ts?q=a%20b", "/a.ts?q=a+b#x"])).toEqual([
      "/a.ts?q=a%20b",
      "/a.ts?q=a+b#x",
    ]);
    expect(await matching(query("x", true), ["/a.ts?raw#x", "/a.ts?raw&x#y"])).toEqual([
      "/a.ts?raw&x#y",
    ]);
    // Combined with `id`, in the worker's prefilter too.
    const filter = [
      include({
        kind: "and",
        args: [id(/\.svg(?:\?.*)?$/), { kind: "query", key: "raw", pattern: true }],
      }),
    ];
    expect(await matching(filter, ["/a.svg", "/a.svg?raw", "/a.ts?raw"])).toEqual(["/a.svg?raw"]);
    const [prefilter] = createPluginPipeline([{ load: { filter, handler() {} } }])!.prefilters;
    const test = createPrefilter([prefilter!]);
    expect(test("/a.svg?raw", "svg")).toBe(true);
    expect(test("/a.svg", "svg")).toBe(false);
    expect(test("/a.svg?raw=0", "svg")).toBe(true);
  });

  it("strips env-runner's own query params, keeping the import's", () => {
    expect(stripInternalQuery("/a.ts")).toBe("/a.ts");
    expect(stripInternalQuery("/a.ts?raw")).toBe("/a.ts?raw");
    expect(stripInternalQuery("/a.ts?__envRunnerReload=3")).toBe("/a.ts");
    expect(stripInternalQuery("/a.ts?raw&__envRunnerReload=3")).toBe("/a.ts?raw");
    // Bun markers lead the query, miniflare's CommonJS shim param ends it.
    expect(stripInternalQuery("/a.ts?__env_runner_virtual&raw")).toBe("/a.ts?raw");
    expect(stripInternalQuery("/a.ts?__env_runner_disk&x=1&v=2", 2)).toBe("/a.ts?x=1");
    expect(stripInternalQuery("/a.txt?__env_runner_plugin&raw")).toBe("/a.txt?raw");
    expect(stripInternalQuery("/a.cjs?raw&__cjs")).toBe("/a.cjs?raw");
    // A virtual module version only when given (and last): `v` may be the import's.
    expect(stripInternalQuery("/a.ts?v=2")).toBe("/a.ts?v=2");
    expect(stripInternalQuery("/a.ts?v=2", 3)).toBe("/a.ts?v=2");
    expect(stripInternalQuery("/a.ts?v=2&v=3", 3)).toBe("/a.ts?v=2");
    expect(stripInternalQuery("/a.ts?raw&v=3", 3)).toBe("/a.ts?raw");
    expect(stripInternalQuery("/a.ts?v=3&raw", 3)).toBe("/a.ts?v=3&raw");
    // Names only: other params are kept as written.
    expect(stripInternalQuery("/a.ts?__cjsx&a=%20&__envRunnerReload")).toBe("/a.ts?__cjsx&a=%20");
    // A resolved id gets a reload's param back.
    expect(restoreInternalQuery("/b.ts", "/a.ts?raw&__envRunnerReload=3")).toBe(
      "/b.ts?__envRunnerReload=3",
    );
    expect(restoreInternalQuery("file:///b.ts?x", "/a.ts?__envRunnerReload=3")).toBe(
      "file:///b.ts?x&__envRunnerReload=3",
    );
    expect(restoreInternalQuery("/b.ts", "/a.ts?raw")).toBe("/b.ts");
  });

  it("validates filter expressions", () => {
    const create = (filter: any) => () =>
      createPluginPipeline([{ transform: { filter, handler() {} } }]);
    expect(create([id("x")])).toThrow(
      /invalid `transform\.filter\[0\]` \(got "id"\): expected an `include` or `exclude` expression/,
    );
    expect(create([include({ kind: "and", args: [] })])).toThrow(
      /`transform\.filter\[0\]\.expr` \(`and` needs at least one argument\)/,
    );
    expect(create([include({ kind: "or", args: [id(1)] })])).toThrow(
      /`transform\.filter\[0\]\.expr\.args\[0\]\.pattern` \(got 1\): expected a string or RegExp/,
    );
    expect(create([include({ kind: "importerId", pattern: /x/ })])).toThrow(/`importerId`/);
    expect(create([include({ kind: "nope" })])).toThrow(/\(got "nope"\): unknown expression kind/);
    expect(create([include({ kind: "query", key: 1, pattern: true })])).toThrow(/\.key` \(got 1\)/);
  });

  it("sends filter expressions to the prefilter, where `code` may match", () => {
    const pipeline = createPluginPipeline([
      {
        transform: {
          filter: [
            exclude(id("**/vendor/**")),
            include({ kind: "and", args: [id(/src/g), code(/MARK/)] }),
          ],
          handler() {},
        },
      },
      { transform: { filter: [exclude(code("SKIP"))], handler() {} } },
    ])!;
    const prefilters = JSON.parse(JSON.stringify(pipeline.prefilters));
    expect(prefilters[0].expr[1]).toEqual(
      include({
        kind: "and",
        args: [id({ source: "src", flags: "" }), code({ source: "MARK", flags: "" })],
      }),
    );
    const only = (index: number) => createPrefilter([prefilters[index]]);
    expect(only(0)("/app/src/a.ts", "ts")).toBe(true);
    expect(only(0)("/app/lib/a.ts", "ts")).toBe(false);
    expect(only(0)("/app/src/vendor/a.ts", "ts")).toBe(false);
    // An exclude that depends on the code: sent.
    expect(only(1)("/app/a.ts", "ts")).toBe(true);
    // The host's `filter()` doesn't know the code either.
    expect(pipeline.filter("/app/src/a.ts")).toBe(true);
    expect(pipeline.filter("/app/lib/a.js")).toBe(true);
  });

  it("names other file types by the `id`/`moduleType` a filter expression matches", async () => {
    const run = async (filter: any, id: string, code = "__V__") => {
      const pipeline = createPluginPipeline([
        { transform: { filter, handler: (code) => code.replace("__V__", "1") } },
      ])!;
      const test = createPrefilter(JSON.parse(JSON.stringify(pipeline.prefilters)));
      const moduleType = moduleTypeOf(id);
      const sent = test(id, moduleType);
      expect(pipeline.filter(id), id).toBe(sent);
      return { sent, code: (await pipeline.transform(id, code, moduleType))?.code };
    };
    // A `moduleType` include types `json`, like `{ moduleType: ["json"] }`.
    expect(await run([include(moduleType("json"))], "/app/data.json", '"__V__"')).toEqual({
      sent: true,
      code: '"1"',
    });
    expect(await run([include(id(/\.json$/))], "/app/data.json")).toEqual({
      sent: false,
      code: undefined,
    });
    // A `code`-only include names no file: other types stay untouched.
    const version = [include(code("__V__"))];
    expect(await run(version, "/app/a.ts")).toEqual({ sent: true, code: "1" });
    expect(await run(version, "/app/a.yaml")).toEqual({ sent: false, code: undefined });
    expect(await run([include({ kind: "not", expr: id(/x/) })], "/app/a.yaml")).toMatchObject({
      sent: false,
    });
    // An `id` in the include that may decide: named, unless only `code` matched.
    const either = [include({ kind: "or", args: [id(/src\//), code("__V__")] })];
    expect(await run(either, "/app/src/a.yaml")).toEqual({ sent: true, code: "1" });
    expect(await run(either, "/app/lib/a.yaml")).toEqual({ sent: false, code: undefined });
    expect(
      await run([include({ kind: "and", args: [id(/\.yaml$/), code("__V__")] })], "/app/a.yaml"),
    ).toEqual({ sent: true, code: "1" });
    // An exclude that depends on the code doesn't hide a later include.
    const skip = [exclude(code("SKIP")), include(id(/\.yaml$/))];
    expect(await run(skip, "/app/a.yaml")).toEqual({ sent: true, code: "1" });
    expect(await run(skip, "/app/a.yaml", "SKIP __V__")).toEqual({ sent: true, code: undefined });
    // A present `query` param names it; an absent one doesn't.
    expect(
      await run([include({ kind: "query", key: "raw", pattern: true })], "/app/a.txt?raw"),
    ).toMatchObject({ sent: true, code: "1" });
    expect(
      await run([include({ kind: "query", key: "raw", pattern: false })], "/app/a.txt"),
    ).toMatchObject({ sent: false });
  });

  it("keeps the position and code frame of errors (`loc`, `pos`, `frame`)", async () => {
    const frame = "1: a\n2: b\n   ^";
    const pipeline = createPluginPipeline([
      {
        name: "parse",
        transform: {
          filter: { id: /thrown/ },
          handler() {
            throw Object.assign(new SyntaxError("Unexpected token"), {
              loc: { line: 2, column: 0, file: "/a.js" },
              frame: `${frame}\n`,
            });
          },
        },
      },
      {
        name: "log",
        transform: {
          filter: { id: /logged/ },
          handler(code) {
            this.error({ message: "bad", pos: code.indexOf("b") });
          },
        },
      },
    ])!;
    await expect(pipeline.transform("/thrown.js", "a\nb")).rejects.toThrow(
      `[env-runner] plugin "parse" failed on "/thrown.js:2:0": Unexpected token\n\n${frame}`,
    );
    await expect(pipeline.transform("/logged.js", "a\nb")).rejects.toThrow(
      /^\[env-runner\] plugin "log" \(\/logged\.js:2:0\): bad$/,
    );
  });

  it("reports plugin errors to `RunnerManager.onClose`, with their position", async () => {
    const manager = new RunnerManager();
    const closed = new Promise<unknown>((resolve) =>
      manager.onClose((_runner, cause) => resolve(cause)),
    );
    const runner = new NodeWorkerEnvRunner({
      name: "plugins-manager-error",
      plugins: [
        {
          name: "failing",
          transform: {
            filter: { id: /dep\.ts$/ },
            handler(code) {
              this.error("no dep here", code.indexOf("export"));
            },
          },
        },
        oxc(),
      ],
      data: { entry: fixture("app.tsx") },
    });
    await manager.reload(runner).catch(() => {});
    const cause: any = await closed;
    expect(String(cause?.message ?? cause)).toMatch(
      /\[env-runner\] plugin "failing" \(.*dep\.ts:\d+:\d+\): no dep here/,
    );
    await manager.close();
  });

  it("gives handlers `this.info`/`this.debug` and log positions", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const pipeline = createPluginPipeline([
      [
        false,
        {
          name: "log",
          transform(code) {
            this.info("hello");
            this.debug("hidden");
            this.warn({ message: "careful" }, code.indexOf("b"));
            this.warn("here", { line: 3, column: 1 });
            return { code: code + ";", moduleSideEffects: false, meta: { x: 1 } };
          },
        },
      ],
      null,
      [
        [
          {
            name: "fail",
            transform() {
              this.error({ message: "boom" }, 0);
            },
          },
        ],
      ],
    ])!;
    expect(pipeline.names).toEqual(["log", "fail"]);
    await expect(pipeline.transform("/a.js", "a\nb")).rejects.toThrow(
      /^\[env-runner\] plugin "fail" \(\/a\.js:1:0\): boom$/,
    );
    expect(info).toHaveBeenCalledWith('[env-runner] plugin "log" (/a.js): hello');
    expect(warn).toHaveBeenCalledWith('[env-runner] plugin "log" (/a.js:2:0): careful');
    expect(warn).toHaveBeenCalledWith('[env-runner] plugin "log" (/a.js:3:1): here');
    expect(debug).not.toHaveBeenCalled();
    info.mockRestore();
    warn.mockRestore();
    debug.mockRestore();
    expect(() => createPluginPipeline([null, [{ resolveId: 1 }]] as any)).toThrow(
      /`plugins\[1\]\[0\]` has an invalid `resolveId` hook/,
    );
  });
});

describe("plugin `resolveId`/`load` hooks", () => {
  it("resolves with the first matching `resolveId` result, in order", async () => {
    const calls: string[] = [];
    const hook = (name: string, result: unknown, order?: "pre" | "post"): EnvRunnerPlugin => ({
      name,
      resolveId: {
        order,
        filter: { id: /^virtual:/ },
        handler(source, importer, options) {
          calls.push(`${name}:${source}:${importer}:${options.isEntry}`);
          return result as any;
        },
      },
    });
    const pipeline = createPluginPipeline([
      hook("none", null),
      hook("first", "\0first"),
      hook("pre", undefined, "pre"),
    ])!;
    expect(pipeline.resolveFilter("virtual:x?q")).toBe(true);
    expect(pipeline.resolveFilter("./x.ts")).toBe(false);
    expect(await pipeline.resolveId("virtual:x", "/app/a.ts")).toEqual({
      id: "\0first",
      external: false,
    });
    expect(calls).toEqual([
      "pre:virtual:x:/app/a.ts:false",
      "none:virtual:x:/app/a.ts:false",
      "first:virtual:x:/app/a.ts:false",
    ]);
    expect(await pipeline.resolveId("./other.ts")).toBeUndefined();

    const external = createPluginPipeline([
      { resolveId: (source) => (source === "a" ? false : { id: "b2", external: "absolute" }) },
    ])!;
    expect(await external.resolveId("a")).toEqual({ id: "a", external: true });
    expect(await external.resolveId("b")).toEqual({ id: "b2", external: true });

    const invalid = createPluginPipeline([{ name: "bad", resolveId: () => ({ id: 1 }) as any }])!;
    await expect(invalid.resolveId("x")).rejects.toThrow(
      /plugin "bad" resolved "x" to an invalid id \(got 1\)/,
    );
    const failing = createPluginPipeline([
      {
        name: "failing",
        resolveId() {
          throw new Error("nope");
        },
      },
    ])!;
    await expect(failing.resolveId("x")).rejects.toThrow(
      '[env-runner] plugin "failing" failed to resolve "x": nope',
    );
  });

  it("resolves with `this.resolve()`: other plugins, then like the runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "env-runner-plugins-"));
    const write = (path: string, code: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), code);
    };
    write("src/a.mjs", "");
    write("src/utils.ts", "");
    write(
      "node_modules/pkg/package.json",
      JSON.stringify({ exports: { workerd: "./workerd.mjs", default: "./node.mjs" } }),
    );
    write("node_modules/pkg/node.mjs", "");
    write("node_modules/pkg/workerd.mjs", "");
    const importer = join(dir, "src/a.mjs");
    try {
      const calls: string[] = [];
      let resolve!: PluginContext["resolve"];
      const pipeline = createPluginPipeline([
        {
          // Wraps what the others resolve (skipping itself by default).
          name: "wrap",
          resolveId: {
            filter: { id: /^#/ },
            async handler(source, importer) {
              calls.push(`wrap:${source}`);
              const resolved = await this.resolve(source, importer);
              return resolved && { id: `${resolved.id}?wrapped`, external: resolved.external };
            },
          },
        },
        {
          // Asks again for the same import: the first plugin stays skipped.
          name: "alias",
          resolveId: {
            filter: { id: /^#/ },
            async handler(source, importer) {
              calls.push(`alias:${source}`);
              return source === "#utils"
                ? await this.resolve("./utils.ts", importer)
                : ((await this.resolve(source, importer)) ?? join(dir, "src/a.mjs"));
            },
          },
        },
        {
          transform(code) {
            resolve = this.resolve;
            return code;
          },
        },
      ])!;
      expect(await pipeline.resolveId("#utils", importer)).toEqual({
        id: `${join(dir, "src/utils.ts")}?wrapped`,
        external: false,
      });
      expect(await pipeline.resolveId("#other", importer)).toEqual({
        id: `${importer}?wrapped`,
        external: false,
      });
      expect(calls).toEqual(["wrap:#utils", "alias:#utils", "wrap:#other", "alias:#other"]);

      // From other hooks: every `resolveId` hook, then like the runtime.
      await pipeline.transform(importer, "x");
      expect(await resolve("#utils", importer)).toEqual({
        id: `${join(dir, "src/utils.ts")}?wrapped`,
        external: false,
      });
      expect(await resolve("./utils.ts?raw", importer)).toEqual({
        id: `${join(dir, "src/utils.ts")}?raw`,
        external: false,
      });
      // No extensions or indexes, as in Node.js; builtins are external.
      expect(await resolve("./utils", importer)).toBeNull();
      expect(await resolve("./missing.ts", importer)).toBeNull();
      expect(await resolve("node:fs")).toEqual({ id: "node:fs", external: true });
      expect(await resolve("pkg", importer)).toEqual({
        id: join(dir, "node_modules/pkg/node.mjs"),
        external: false,
      });
      // The runner's export conditions.
      const workerd = createPluginPipeline(
        [
          {
            transform(code) {
              resolve = this.resolve;
              return code;
            },
          },
        ],
        { resolveConditions: () => ["workerd", "worker"] },
      )!;
      await workerd.transform(importer, "x");
      expect(await resolve("pkg", importer)).toEqual({
        id: join(dir, "node_modules/pkg/workerd.mjs"),
        external: false,
      });
      // Without `skipSelf`, a plugin sees its own call.
      let depth = 0;
      const self = createPluginPipeline([
        {
          resolveId: {
            filter: { id: /^#/ },
            async handler(source, importer) {
              if (depth++ > 0) {
                return `\0${source}`;
              }
              return this.resolve(source, importer, { skipSelf: false });
            },
          },
        },
      ])!;
      expect(await self.resolveId("#x")).toEqual({ id: "\0#x", external: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs `fallback` resolveId hooks only for imports the runtime failed to resolve", async () => {
    const calls: string[] = [];
    const hook = (name: string, fallback?: boolean): EnvRunnerPlugin => ({
      name,
      resolveId: {
        fallback,
        filter: { id: fallback ? /^\./ : /^#/ },
        handler(source) {
          calls.push(`${name}:${source}`);
          return `/${name}${source.slice(1)}`;
        },
      },
    });
    const pipeline = createPluginPipeline([hook("late", true), hook("early")])!;
    // Sent before the runtime resolves, or after it failed.
    expect(pipeline.resolveFilter("#a")).toBe(true);
    expect(pipeline.resolveFilter("./a")).toBe(false);
    expect(pipeline.resolveFilter("./a", true)).toBe(true);
    expect(pipeline.resolveFilter("#a", true)).toBe(false);
    expect(JSON.parse(JSON.stringify(pipeline.resolvePrefilters))[0]).toMatchObject({
      fallback: true,
    });
    expect(await pipeline.resolveId("./a")).toBeUndefined();
    expect(await pipeline.resolveId("./a", undefined, { fallback: true })).toEqual({
      id: "/late/a",
      external: false,
    });
    expect(calls).toEqual(["late:./a"]);
    // `this.resolve()`: the other hooks, the runtime, then the `fallback` ones.
    let resolve!: PluginContext["resolve"];
    const context = createPluginPipeline([
      hook("late", true),
      {
        transform(code) {
          resolve = this.resolve;
          return code;
        },
      },
    ])!;
    await context.transform("/app/a.ts", "x");
    expect(await resolve("./missing", "/app/a.ts")).toEqual({
      id: "/late/missing",
      external: false,
    });
    expect(await resolve(fixture("dep.ts"), "/app/a.ts")).toEqual({
      id: fixture("dep.ts"),
      external: false,
    });
    const create = (hook: unknown) => () => createPluginPipeline([hook as EnvRunnerPlugin]);
    expect(create({ transform: { fallback: true, handler() {} } })).toThrow(
      /`transform\.fallback` \(only `resolveId` hooks take one\)/,
    );
    expect(create({ resolveId: { fallback: 1, handler() {} } })).toThrow(
      /invalid `resolveId\.fallback` \(1\)/,
    );
  });

  it("matches `resolveId` globs against specifiers as written", () => {
    const pipeline = createPluginPipeline([
      { resolveId: { filter: { id: ["virtual:*", "~icons/**"] }, handler() {} } },
    ])!;
    expect(pipeline.resolveFilter("virtual:a")).toBe(true);
    expect(pipeline.resolveFilter("~icons/mdi/home")).toBe(true);
    expect(pipeline.resolveFilter("./virtual:a")).toBe(false);
    expect(resolveSchemes(pipeline.resolvePrefilters)).toEqual(["virtual"]);
    expect(createBunResolveFilter(pipeline.resolvePrefilters).test("virtual:a")).toBe(true);
    expect(createBunResolveFilter(pipeline.resolvePrefilters).test("./a.ts")).toBe(false);
  });

  it("finds the schemes of `resolveId` filters for Bun namespaces", () => {
    const schemes = (filter: any) =>
      resolveSchemes(
        createPluginPipeline([{ resolveId: { filter, handler() {} } }])!.resolvePrefilters,
      );
    expect(schemes({ id: [/^virtual:/, /^my\.scheme:x/, /^node:/, /^C:/, /icons:/] })).toEqual([
      "virtual",
      "my.scheme",
    ]);
    expect(
      schemes([
        {
          kind: "include",
          expr: {
            kind: "or",
            args: [
              { kind: "id", pattern: /^a-b:/ },
              { kind: "id", pattern: "xy:*" },
            ],
          },
        },
      ]),
    ).toEqual(["a-b", "xy"]);
    // No includes: any specifier.
    const all = createPluginPipeline([{ resolveId: () => null }])!.resolvePrefilters;
    expect(createBunResolveFilter(all).test("anything")).toBe(true);
  });

  it("loads modules with `load` hooks, then transforms them", async () => {
    const pipeline = createPluginPipeline([
      {
        name: "virtual",
        load: {
          filter: { id: /^\0virtual:/ },
          handler(id) {
            if (id === "\0virtual:ts") {
              return {
                code: "export const x: number = 1;",
                map: { mappings: "AAAA" },
                moduleType: "ts",
              };
            }
            return id === "\0virtual:plain" ? "export default 1;" : null;
          },
        },
        transform: {
          filter: { moduleType: ["ts"] },
          handler: (code) => ({ code: code.replace(": number", ""), moduleType: "js" }),
        },
      },
    ])!;
    const ts = (await pipeline.load("\0virtual:ts"))!;
    expect(ts.moduleType).toBe("js");
    expect(ts.code).toMatch(/^export const x = 1;\n\/\/# sourceMappingURL=data:/);
    // Loaded modules always have code, also when no `transform` changes them.
    expect(await pipeline.load("\0virtual:plain")).toEqual({
      code: "export default 1;",
      moduleType: "js",
    });
    await expect(pipeline.load("\0virtual:missing")).rejects.toThrow(
      /no plugin loaded "\0virtual:missing": a `resolveId` hook resolved an import to it/,
    );
    // Files no `load` hook returns code for are read (only when a filter matches).
    const read = vi.fn(() => "export const a: number = 1;");
    expect(await pipeline.load("/app/a.ts", read)).toEqual({
      code: "export const a = 1;",
      moduleType: "js",
    });
    expect(await pipeline.load("/app/a.js", read)).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  });

  it("reports `load` errors and invalid code", async () => {
    const pipeline = createPluginPipeline([
      {
        name: "failing",
        load(id) {
          if (id === "\0bad") {
            return { code: 1 } as any;
          }
          throw new Error("nope");
        },
      },
    ])!;
    await expect(pipeline.load("\0x")).rejects.toThrow(
      '[env-runner] plugin "failing" failed to load "\0x": nope',
    );
    await expect(pipeline.load("\0bad")).rejects.toThrow(
      /plugin "failing" loaded non-string `code` for "\0bad" \(got 1\)/,
    );
  });

  it("only sends other file types to filters naming them", async () => {
    expect(moduleTypeOf("/app/a.vue")).toBe("vue");
    expect(moduleTypeOf("/app/a.JSON?x")).toBe("json");
    expect(moduleTypeOf("/app/a.mts")).toBe("ts");
    expect(moduleTypeOf("\0virtual:x")).toBe("js");
    const any = createPluginPipeline([{ transform: () => {} }])!;
    const named = createPluginPipeline([
      { transform: { filter: { id: "**/*.vue" }, handler() {} } },
    ])!;
    const dir = createPluginPipeline([{ transform: { filter: { id: "/app/**" }, handler() {} } }])!;
    const json = createPluginPipeline([
      { transform: { filter: { moduleType: ["json"] }, handler() {} } },
    ])!;
    const load = createPluginPipeline([{ load: { filter: { id: "/app/**" }, handler() {} } }])!;
    expect(any.filter("/app/a.ts")).toBe(true);
    expect(any.filter("/app/a.vue")).toBe(false);
    expect(named.filter("/app/a.vue")).toBe(true);
    expect(dir.filter("/app/a.vue")).toBe(true);
    // Files the runtime loads itself need their type listed (or a `load` filter).
    expect(dir.filter("/app/a.json")).toBe(false);
    expect(json.filter("/app/a.json")).toBe(true);
    expect(json.filter("/app/node_modules/x/a.json")).toBe(false);
    expect(load.filter("/app/a.json")).toBe(true);
    expect(load.filter("/app/a.wasm")).toBe(true);
    // The worker's prefilter agrees.
    const prefilter = createPrefilter(JSON.parse(JSON.stringify(dir.prefilters)));
    expect(prefilter("/app/a.vue", "vue")).toBe(true);
    expect(prefilter("/app/a.json", "json")).toBe(false);
  });

  it("types other files `js` once a plugin turns them into code", async () => {
    const seen: string[] = [];
    const pipeline = createPluginPipeline([
      {
        name: "vue",
        transform: {
          filter: { id: /\.vue$/ },
          handler: (code) => `export default ${JSON.stringify(code)};`,
        },
      },
      // Unfiltered: sees the module once it is JavaScript.
      {
        name: "any",
        transform: (_code, id, { moduleType }) => void seen.push(`${id}:${moduleType}`),
      },
      {
        name: "json",
        transform: {
          filter: { moduleType: ["json"] },
          handler: (code, id) =>
            id.endsWith("code.json") ? `export default ${code};` : code.replace("1", "2"),
        },
      },
    ])!;
    expect(await pipeline.transform("/app/a.vue", "<template/>")).toEqual({
      code: 'export default "<template/>";',
      moduleType: "js",
    });
    expect(seen).toEqual(["/app/a.vue:js"]);
    // JSON stays JSON, unless a plugin rewrote it as code.
    expect(await pipeline.transform("/app/a.json", '{"a":1}')).toEqual({
      code: '{"a":2}',
      moduleType: "json",
    });
    expect(await pipeline.transform("/app/code.json", '{"a":1}')).toEqual({
      code: 'export default {"a":1};',
      moduleType: "js",
    });
    expect(seen).toEqual(["/app/a.vue:js"]);
  });

  it("orders plugins by `enforce`, then each hook by its `order`", async () => {
    const calls: string[] = [];
    const plugin = (name: string, enforce?: "pre" | "post", order?: "pre" | "post") =>
      ({
        name,
        enforce,
        transform: { order, handler: () => void calls.push(name) },
      }) as EnvRunnerPlugin;
    const pipeline = createPluginPipeline([
      plugin("post", "post"),
      plugin("normal"),
      plugin("normal-hook-pre", undefined, "pre"),
      plugin("pre", "pre"),
      plugin("post-hook-pre", "post", "pre"),
    ])!;
    await pipeline.transform("/a.ts", "x");
    expect(calls).toEqual(["normal-hook-pre", "post-hook-pre", "pre", "normal", "post"]);
    expect(pipeline.names).toEqual(["post", "normal", "normal-hook-pre", "pre", "post-hook-pre"]);
    expect(() => createPluginPipeline([{ enforce: "first" } as any])).toThrow(
      /`plugins\[0\]` has an invalid `enforce` \("first"\)/,
    );
  });

  it("gives handlers no-op watch file methods and `meta`", async () => {
    const pipeline = createPluginPipeline([
      {
        transform() {
          this.addWatchFile("/other.txt");
          return `${JSON.stringify(this.getWatchFiles())} ${this.meta.watchMode}`;
        },
      },
    ])!;
    expect((await pipeline.transform("/a.ts", "x"))!.code).toBe("[] false");
  });

  it("opts node_modules in for `id` includes naming it, and resolved paths", () => {
    const pipeline = (filter: any) =>
      createPluginPipeline([{ transform: { filter, handler() {} } }])!;
    const any = pipeline(undefined);
    expect(any.filter("/app/node_modules/pkg/a.ts")).toBe(false);
    expect(any.filter("/app/node_modules/pkg/a.ts", undefined, true)).toBe(true);
    expect(any.filter("/app/node_modules/pkg/a.ts", "ts")).toBe(true);
    const named = pipeline({ id: ["**/node_modules/pkg/**", "**/src/**"] });
    expect(named.filter("/app/node_modules/pkg/a.ts")).toBe(true);
    expect(named.filter(String.raw`C:\app\node_modules\pkg\a.ts`)).toBe(true);
    // Another include matching doesn't count.
    expect(named.filter("/app/node_modules/other/src/a.ts")).toBe(false);
    const expr = pipeline([
      { kind: "include", expr: { kind: "id", pattern: /node_modules\/pkg\// } },
    ]);
    expect(expr.filter("/app/node_modules/pkg/a.ts")).toBe(true);
    expect(expr.filter("/app/node_modules/other/a.ts")).toBe(false);
    // Bun: only plugins whose folded includes name it drop the guard.
    expect(createBunFilter(named.prefilters, false).test("/app/node_modules/pkg/a.ts")).toBe(true);
    expect(createBunFilter(named.prefilters, false).test("/app/node_modules/x/a.ts")).toBe(false);
    expect(createBunFilter(any.prefilters, false).test("/app/node_modules/pkg/a.ts")).toBe(false);
  });

  it("accepts only the worker's connection on the process socket", async () => {
    if (process.platform === "win32") {
      return;
    }
    const host = openTransformSocket(createPluginPipeline([{ transform: () => {} }])!);
    const path = host.channel.socket!;
    try {
      const first = connect(path);
      await new Promise((resolve, reject) => first.once("connect", resolve).once("error", reject));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The socket file (and its directory) is gone: nobody else can connect.
      expect(existsSync(dirname(path))).toBe(false);
      const second = connect(path);
      await expect(
        new Promise((resolve, reject) => second.once("connect", resolve).once("error", reject)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      first.destroy();
    } finally {
      host.close();
    }
  });

  it("keeps other file types out of Bun's `onLoad` filter", () => {
    const filter = (plugin: EnvRunnerPlugin) =>
      createBunFilter(createPluginPipeline([plugin])!.prefilters, false);
    // `onLoad` can't decline: they are loaded while resolving instead.
    const named = filter({ transform: { filter: { id: ["/app/**", /\.vue$/] }, handler() {} } });
    expect(named.test("/app/a.ts")).toBe(true);
    expect(named.test("/app/a.vue")).toBe(false);
    expect(named.test("/app/a.txt")).toBe(false);
    const json = filter({ transform: { filter: { moduleType: ["json"] }, handler() {} } });
    expect(json.test("/app/a.json")).toBe(false);
  });

  it("serves plugin ids with any extension from plain `load` hooks", async () => {
    const pipeline = createPluginPipeline([
      {
        resolveId: (source) => (source === "virtual:config.json" ? "\0config.json" : null),
        load: (id) => (id === "\0config.json" ? '{"a":1}' : id === "\0x.vue" ? "<p/>" : null),
      },
      // Unfiltered: doesn't see JSON (another type), sees the `.vue` module as `js`.
      { transform: (_code, _id, { moduleType }) => `// ${moduleType}` },
    ])!;
    expect(await pipeline.load("\0config.json")).toEqual({ code: '{"a":1}', moduleType: "json" });
    // Loaded code of another type without a `moduleType` becomes `js`.
    expect(await pipeline.load("\0x.vue")).toEqual({ code: "// js", moduleType: "js" });
    // Disk files still need a filter naming them.
    expect(await pipeline.load("/app/c.json", () => '{"b":1}')).toBeUndefined();
  });
});
