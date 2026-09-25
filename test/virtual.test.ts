import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";

import type { EnvRunner } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDeno = hasRuntime("deno");
const hasBun = hasRuntime("bun");

// Deno serves virtual .ts modules via `module.stripTypeScriptTypes`, in its
// node:module compat since 2.8.2 (older Deno fails fast at registration).
function denoSupportsTypeStripping(): boolean {
  if (!hasDeno) return false;
  try {
    execFileSync(
      "deno",
      [
        "eval",
        `const m = await import("node:module"); if (typeof m.stripTypeScriptTypes !== "function") Deno.exit(1);`,
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
const denoTypeStripping = denoSupportsTypeStripping();

const _dir = dirname(fileURLToPath(import.meta.url));
const virtualAppEntry = resolve(_dir, "./fixtures/app-virtual.mjs");
// Real files (`app.mjs` importing `./config.mjs`, `helper.mjs`) next to path keys.
const pathsDir = resolve(_dir, "./fixtures/virtual-paths");
// Doesn't exist on disk: path keys may live in a virtual directory.
const ghostDir = resolve(pathsDir, "virtual");

const runners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  // Bun lacks `module.registerHooks()`; virtual modules use `Bun.plugin()` instead.
  {
    name: "BunProcessEnvRunner",
    create: (opts: any) => new BunProcessEnvRunner(opts),
    skip: !hasBun,
    bun: true,
  },
  // Deno >= 2.8 supports `module.registerHooks()`; skipped when deno is absent.
  {
    name: "DenoProcessEnvRunner",
    create: (opts: any) => new DenoProcessEnvRunner(opts),
    skip: !hasDeno,
    deno: true,
  },
  // Miniflare serves virtual modules through `unsafeModuleFallbackService`
  // (workerd), with `.ts`/`.mts` sources type-stripped on the host.
  {
    name: "MiniflareEnvRunner",
    create: (opts: any) => new MiniflareEnvRunner({ miniflare, ...opts }),
    miniflare: true,
  },
];

for (const { name, create, skip, bun, deno, miniflare } of runners) {
  describe.skipIf(skip ?? false)(`${name} virtual modules`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    it("resolves a virtual import from the `data.virtual` map", async () => {
      runner = create({
        name: "virtual-test",
        data: {
          entry: virtualAppEntry,
          virtual: {
            "#virtual-message": `export const message = "hello from virtual";`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hello from virtual");
    });

    it("uses a virtual module as the entry itself", async () => {
      runner = create({
        name: "virtual-entry",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default { fetch: () => new Response("hi from virtual entry") };`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hi from virtual entry");
    });

    it("resolves a virtual entry that imports another virtual module", async () => {
      runner = create({
        name: "virtual-entry-compose",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import { body } from "#dep";
              export default { fetch: () => new Response(body) };`,
            "#dep": `export const body = "composed virtual";`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("composed virtual");
    });

    // Process runners pass `data` over IPC, not a size-limited env var (Linux
    // caps one env string at 128 KiB: `spawn E2BIG`).
    it("serves a large (1 MiB) virtual module", async () => {
      // Quotes, backslashes, newlines and non-BMP chars exercise the JSON framing.
      const unit = `a"b\\c\nd é漢😀 `;
      const payload = unit.repeat(Math.ceil(1024 ** 2 / unit.length));
      runner = create({
        name: "virtual-large",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import payload from "#large";
              export default { fetch: () => new Response(payload) };`,
            "#large": `export default ${JSON.stringify(payload)};`,
          },
        },
      });
      await runner.waitForReady();
      const text = await (await runner.fetch("http://localhost/")).text();
      expect(text.length).toBe(payload.length);
      expect(text === payload).toBe(true);
    });

    // Deno ignores the `format` of custom load hooks; virtual `.ts` sources are
    // pre-stripped with `module.stripTypeScriptTypes` (Deno >= 2.8.2) and
    // registration throws a clear error on older Deno without it.
    it.skipIf(deno && !denoTypeStripping)(
      "resolves virtual TypeScript modules (.ts entry and import)",
      async () => {
        runner = create({
          name: "virtual-ts",
          data: {
            entry: "#entry.ts",
            virtual: {
              "#entry.ts": `import { getMessage } from "#util.ts";
              const handler: () => Response = () => new Response(getMessage());
              export default { fetch: handler };`,
              "#util.ts": `export function getMessage(): string {
              const value: string = "hello from typescript";
              return value;
            }`,
            },
          },
        });
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.text()).toBe("hello from typescript");
      },
    );

    it.skipIf(!deno || denoTypeStripping)(
      "fails fast for a virtual TypeScript module on Deno without stripTypeScriptTypes",
      async () => {
        let closeCause: unknown;
        runner = create({
          name: "virtual-ts-deno",
          hooks: {
            onClose: (_runner: EnvRunner, cause: unknown) => {
              closeCause = cause;
            },
          },
          data: {
            entry: "#entry.ts",
            virtual: {
              "#entry.ts": `export default { fetch: () => new Response("unreachable") };`,
            },
          },
        });
        await expect(runner.waitForReady(3000)).rejects.toThrow();
        expect(runner.closed).toBe(true);
        // The worker reports the failure via an `init-error` message, so the
        // close cause carries the actionable error instead of a bare exit code.
        expect(String((closeCause as Error)?.message)).toContain("stripTypeScriptTypes");
      },
    );

    // A bare/relative import inside a virtual module arrives with a `virtual:`
    // parentURL; default resolution must be re-based on a real directory (the
    // cwd) instead of crashing on the opaque scheme. Bun resolves imports from
    // non-path virtual modules from cwd too. Miniflare (workerd) doesn't use
    // these resolve hooks.
    it.skipIf(miniflare)("resolves a bare dependency imported by a virtual module", async () => {
      runner = create({
        name: "virtual-bare-import",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import { resolveModulePath } from "exsolve";
                export default { fetch: () => new Response(typeof resolveModulePath) };`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("function");
    });

    it("resolves a virtual JSON module", async () => {
      runner = create({
        name: "virtual-json",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import config from "#config.json";
              export default { fetch: () => new Response(config.nested.message) };`,
            "#config.json": JSON.stringify({ nested: { message: "hello from json" } }),
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("hello from json");
    });

    // Deno-side limitation: static imports carrying an import attribute bypass
    // `registerHooks` resolution entirely. workerd rejects import attributes
    // outright ("Unrecognized import attributes specified"). Node/Bun only.
    it.skipIf(deno || miniflare)(
      `resolves a virtual JSON module imported with { type: "json" }`,
      async () => {
        runner = create({
          name: "virtual-json-attr",
          data: {
            entry: "#entry",
            virtual: {
              "#entry": `import config from "#config.json" with { type: "json" };
              export default { fetch: () => new Response(config.message) };`,
              "#config.json": JSON.stringify({ message: "json with attribute" }),
            },
          },
        });
        await runner.waitForReady();
        const res = await runner.fetch("http://localhost/");
        expect(await res.text()).toBe("json with attribute");
      },
    );

    it("resolves a factory-valued virtual source (sync and async)", async () => {
      runner = create({
        name: "virtual-factory",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": () => `import { body } from "#dep";
              export default { fetch: () => new Response(body) };`,
            "#dep": async () => `export const body = "from factory";`,
          },
        },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("from factory");
    });

    it("prefers a virtual override over a real file with the same path", async () => {
      runner = create({
        name: "virtual-override",
        data: {
          // A real file exists at this path; the virtual source must win,
          // both on initial import and across reloadModule().
          entry: virtualAppEntry,
          virtual: {
            [virtualAppEntry]: `export default { fetch: () => new Response("virtual override") };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("virtual override");
      await runner.reloadModule?.();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("virtual override");
    });

    it("closes the runner with the factory error as cause when a factory throws", async () => {
      let closeCause: unknown;
      runner = create({
        name: "virtual-factory-error",
        hooks: {
          onClose: (_runner: EnvRunner, cause: unknown) => {
            closeCause = cause;
          },
        },
        data: {
          entry: "#entry",
          virtual: {
            "#entry": () => {
              throw new Error("factory failed");
            },
          },
        },
      });
      await expect(runner.waitForReady(1000)).rejects.toThrow();
      expect(runner.closed).toBe(true);
      expect((closeCause as Error)?.message).toBe("factory failed");
    });

    // Miniflare has no graceful-shutdown handshake/exit event and nothing to
    // unregister — the fallback-service closure dies with the instance.
    it.skipIf(miniflare)(
      "unregisters virtual modules on shutdown without breaking close",
      async () => {
        runner = create({
          name: "virtual-unregister",
          data: {
            entry: "#entry",
            virtual: {
              "#entry": `export default { fetch: () => new Response("ok") };`,
            },
          },
        });
        await runner.waitForReady();
        // Graceful path: workers call unregisterVirtualModules() in their
        // shutdown handler and confirm with an exit event.
        const exited = new Promise((resolve) => {
          runner.onMessage((message: any) => {
            if (message?.event === "exit") resolve(message);
          });
        });
        runner.sendMessage({ event: "shutdown" });
        await expect(
          Promise.race([
            exited,
            new Promise((_, reject) => setTimeout(() => reject(new Error("no exit event")), 5000)),
          ]),
        ).resolves.toBeTruthy();
        await runner.close();
      },
    );

    it("invalidates a virtual module so reload re-runs its factory source", async () => {
      let counter = 0;
      runner = create({
        name: "virtual-invalidate",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import config from "#config.json";
              export default { fetch: () => new Response(String(config.count)) };`,
            "#config.json": () => JSON.stringify({ count: counter++ }),
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("0");

      // Reload alone keeps the cached dependency (the factory is not re-run)
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("0");

      // Invalidate + reload re-runs the factory and re-imports the graph
      await runner.invalidateModule!("#config.json");
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("1");

      // Repeated invalidation keeps working
      await runner.invalidateModule!("#config.json");
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("2");
    });

    it("invalidation reaches a module imported through an intermediate virtual module", async () => {
      let counter = 0;
      runner = create({
        name: "virtual-invalidate-transitive",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import { count } from "#middle";
              export default { fetch: () => new Response(String(count)) };`,
            "#middle": `import config from "#config.json";
              export const count = config.count;`,
            "#config.json": () => JSON.stringify({ count: counter++ }),
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("0");

      // The intermediate importer (#middle) must also get a fresh identity,
      // otherwise its cached instance keeps linking the old #config.json.
      await runner.invalidateModule!("#config.json");
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("1");

      await runner.invalidateModule!("#config.json");
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("2");
    });

    it("rejects invalidating an unknown virtual specifier", async () => {
      runner = create({
        name: "virtual-invalidate-unknown",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default { fetch: () => new Response("ok") };`,
          },
        },
      });
      await runner.waitForReady();
      await expect(runner.invalidateModule!("#unknown")).rejects.toThrow(
        'Cannot invalidate "#unknown"',
      );
    });

    it("reloads a virtual entry without restarting the worker", async () => {
      runner = create({
        name: "virtual-entry-reload",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default { fetch: () => new Response("before reload") };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("before reload");
      await runner.reloadModule?.();
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("before reload");
    });

    // Path keys (absolute paths / `file:` URLs) are matched by resolved URL, so
    // relative imports between them work even where no directory exists.
    it("resolves relative imports between path-keyed virtual modules", async () => {
      runner = create({
        name: "virtual-path-relative",
        data: {
          entry: resolve(ghostDir, "entry.mjs"),
          virtual: {
            [resolve(ghostDir, "entry.mjs")]: `import { a } from "./a.mjs";
              import { b } from "./nested/b.mjs";
              export default { fetch: () => new Response(a + b) };`,
            [resolve(ghostDir, "a.mjs")]: `export const a = "a";`,
            [resolve(ghostDir, "nested/b.mjs")]: `import { c } from "../c.mjs";
              export const b = "b" + c;`,
            [resolve(ghostDir, "c.mjs")]: `export const c = "c";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("abc");
    });

    it("matches `file:` URL keys like paths", async () => {
      runner = create({
        name: "virtual-path-file-url",
        data: {
          entry: pathToFileURL(resolve(ghostDir, "entry.mjs")).href,
          virtual: {
            [pathToFileURL(resolve(ghostDir, "entry.mjs")).href]: `import { dep } from "./dep.mjs";
              export default { fetch: () => new Response(dep) };`,
            [pathToFileURL(resolve(ghostDir, "dep.mjs")).href]:
              `export const dep = "file url key";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("file url key");
    });

    it("overrides a real file imported relatively by a disk module", async () => {
      runner = create({
        name: "virtual-path-override",
        data: {
          // `app.mjs` imports `./config.mjs`, which also exists on disk.
          entry: resolve(pathsDir, "app.mjs"),
          virtual: {
            [resolve(pathsDir, "config.mjs")]: `export default "virtual config";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("virtual config");
    });

    it("resolves real files relative to a path-keyed virtual module", async () => {
      runner = create({
        name: "virtual-path-real-import",
        data: {
          entry: resolve(ghostDir, "entry.mjs"),
          virtual: {
            [resolve(ghostDir, "entry.mjs")]: `import helper from "../helper.mjs";
              export default { fetch: () => new Response(helper) };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("disk helper");
    });

    it("resolves bare packages from a path-keyed virtual module's directory", async () => {
      runner = create({
        name: "virtual-path-bare-import",
        data: {
          entry: resolve(ghostDir, "entry.mjs"),
          virtual: {
            [resolve(ghostDir, "entry.mjs")]: `import { resolveModulePath } from "exsolve";
              export default { fetch: () => new Response(typeof resolveModulePath) };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("function");
    });

    // workerd leaves `import.meta.url`/`dirname`/`filename` undefined for
    // fallback-served modules.
    it.skipIf(miniflare)(
      "exposes the key's `file:` URL as `import.meta.url` of a path-keyed module",
      async () => {
        const entry = resolve(ghostDir, "entry.mjs");
        runner = create({
          name: "virtual-path-import-meta",
          data: {
            entry,
            virtual: {
              [entry]: `export default { fetch: () => Response.json({
                url: import.meta.url,
                dirname: import.meta.dirname,
                filename: import.meta.filename,
              }) };`,
            },
          },
        });
        await runner.waitForReady();
        const expected = { url: pathToFileURL(entry).href, dirname: ghostDir, filename: entry };
        expect(await (await runner.fetch("http://localhost/")).json()).toEqual(expected);
        // Reloads add a cache-busting query to the URL (Bun: `?v=<n>`).
        await runner.reloadModule!();
        const reloaded = await (await runner.fetch("http://localhost/")).json();
        expect({ ...reloaded, url: reloaded.url.split("?")[0] }).toEqual(expected);
      },
    );

    // Node/Deno serve non-path keys as `virtual:<key>`, readable in stack
    // traces. Bun and miniflare use their own ids (see VIRTUAL-MODULES.md).
    it.skipIf(bun || miniflare)(
      "serves non-path keys under a readable `virtual:` URL",
      async () => {
        runner = create({
          name: "virtual-url",
          data: {
            entry: "#entry",
            virtual: {
              "#entry": `import { url, stack } from "#lib/meta";
                export default { fetch: () => Response.json({ entry: import.meta.url, url, stack }) };`,
              "#lib/meta": `export const url = import.meta.url;\nexport const stack = new Error("x").stack;`,
            },
          },
        });
        await runner.waitForReady();
        const { entry, url, stack } = await (await runner.fetch("http://localhost/")).json();
        expect(entry).toBe("virtual:#entry");
        expect(url).toBe("virtual:#lib/meta");
        expect(stack).toMatch(/^ +at virtual:#lib\/meta:2:\d+$/m);
      },
    );

    // Checked on the host before spawn, so every runner warns the same way.
    it("warns about path keys naming the same file", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Unique per runner: each pair only warns once per process.
      const file = resolve(ghostDir, `collision-${name}.mjs`);
      try {
        runner = create({
          name: "virtual-collision",
          data: {
            entry: "#entry",
            virtual: {
              "#entry": `export default { fetch: () => new Response("ok") };`,
              [file]: `export default 1;`,
              [pathToFileURL(file).href]: `export default 2;`,
            },
          },
        });
        await runner.waitForReady();
        const warnings = warn.mock.calls.filter(([m]) => String(m).includes("same file"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]![0]).toContain(`"${file}" and "${pathToFileURL(file).href}"`);
      } finally {
        warn.mockRestore();
      }
    });

    // Init errors name the failing virtual module (see `formatInitError()`).
    const initError = async (virtual: Record<string, string>): Promise<string> => {
      runner = create({ name: "virtual-init-error", data: { entry: "#entry", virtual } });
      const error = await runner.waitForReady().catch((error) => error);
      return String(error?.cause?.message);
    };

    it("names the virtual module that throws during init", async () => {
      const message = await initError({
        "#entry": `import "#dep";\nexport default { fetch: () => new Response("unreachable") };`,
        "#dep": `export const x = 1;\nthrow new Error("dep failed");`,
      });
      expect(message).toMatch(/dep failed \(at (virtual:)?#dep:2:\d+\)/);
    });

    it.skipIf(deno && !denoTypeStripping)(
      "names the virtual TypeScript module that fails to parse",
      async () => {
        const message = await initError({
          "#entry": `import "#dep.ts";\nexport default { fetch: () => new Response("unreachable") };`,
          "#dep.ts": `export const x: number = ;`,
        });
        expect(message).toContain("#dep.ts");
      },
    );

    // workerd parses JSON modules itself, and its error doesn't say which.
    it.skipIf(miniflare)("names the virtual JSON module that fails to parse", async () => {
      const message = await initError({
        "#entry": `import "#dep.json";\nexport default { fetch: () => new Response("unreachable") };`,
        "#dep.json": `{ "broken": `,
      });
      expect(message).toContain("#dep.json");
    });

    // Lookups strip an import's `?query` (it stays in the module id).
    it("resolves virtual imports with a query appended", async () => {
      runner = create({
        name: "virtual-query",
        data: {
          entry: resolve(ghostDir, "entry.mjs"),
          virtual: {
            [resolve(ghostDir, "entry.mjs")]: `import { a } from "#a.mjs?raw";
              import { b } from "./b.mjs?raw";
              export default { fetch: () => new Response(a + b) };`,
            "#a.mjs": `export const a = "a";`,
            [resolve(ghostDir, "b.mjs")]: `export const b = "b";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("ab");
    });

    // Bun only calls runtime `onResolve` when the specifier's last `.` precedes
    // a letter, so an extensionless key is only matched verbatim (`build.module`).
    it.skipIf(bun)("resolves an extensionless virtual key with a query appended", async () => {
      runner = create({
        name: "virtual-query-extensionless",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import { m } from "#m?raw";
              export default { fetch: () => new Response(m) };`,
            "#m": `export const m = "extensionless";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("extensionless");
    });

    it("invalidation reaches a path-keyed module through relative intermediate importers", async () => {
      let counter = 0;
      const dep = resolve(ghostDir, "dep.mjs");
      runner = create({
        name: "virtual-path-invalidate-transitive",
        data: {
          entry: resolve(ghostDir, "entry.mjs"),
          virtual: {
            [resolve(ghostDir, "entry.mjs")]: `import { count } from "./mid.mjs";
              export default { fetch: () => new Response(String(count)) };`,
            // Neither importer mentions the dependency's key verbatim.
            [resolve(ghostDir, "mid.mjs")]: `import dep from "./dep.mjs";
              export const count = dep;`,
            [dep]: () => `export default ${counter++};`,
          },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("0");

      await runner.invalidateModule!(dep);
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("1");

      await runner.invalidateModule!(dep);
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("2");
    });
  });
}

// --- Disk importers of virtual modules ---

// `app.mjs` → `./lib.mjs` → `./deep.mjs` → `#count`, plus `./unrelated.mjs`;
// both chains import `./shared.mjs`. Each disk module counts its evaluations.
const importersDir = resolve(_dir, "./fixtures/virtual-importers");

for (const { name, create, skip, bun, miniflare } of runners) {
  describe.skipIf(skip ?? false)(`${name} virtual modules: disk importers`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    const state = async () => (await runner.fetch("http://localhost/")).json();

    // Reloading re-imports the disk entry under its own URL, so it links the
    // fresh virtual module (on Deno, the old `data:` URL reload failed outright
    // once load hooks were registered).
    it("a reloaded disk entry picks up an invalidated virtual import", async () => {
      let counter = 0;
      runner = create({
        name: "virtual-disk-entry",
        data: {
          entry: virtualAppEntry,
          virtual: { "#virtual-message": () => `export const message = "v${counter++}";` },
        },
      });
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("v0");
      await runner.invalidateModule!("#virtual-message");
      await runner.reloadModule!();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("v1");
    });

    // Needs resolve hooks to observe disk importers (Node/Deno `registerHooks`).
    // Bun's `Bun.plugin` and miniflare's fallback service don't expose them, so
    // there a cached disk module keeps linking the old virtual instance.
    it.skipIf(bun || miniflare)(
      "invalidation re-evaluates disk modules that import the virtual module",
      async () => {
        let counter = 0;
        runner = create({
          name: "virtual-disk-importers",
          data: {
            entry: resolve(importersDir, "app.mjs"),
            virtual: { "#count": () => `export default ${counter++};` },
          },
        });
        await runner.waitForReady();
        const initial = { lib: 1, deep: 1, shared: 1, unrelated: 1 };
        expect(await state()).toEqual({ count: 0, evaluations: initial });

        // A plain reload re-evaluates only the entry.
        await runner.reloadModule!();
        expect(await state()).toEqual({ count: 0, evaluations: initial });

        for (const count of [1, 2]) {
          await runner.invalidateModule!("#count");
          await runner.reloadModule!();
          // Only the importer chain is re-evaluated; `shared.mjs` stays one
          // instance for both the fresh `deep.mjs` and the cached `unrelated.mjs`.
          expect(await state()).toEqual({
            count,
            evaluations: { ...initial, lib: count + 1, deep: count + 1 },
          });
        }
      },
    );

    // Same, through a path-keyed virtual entry: key → disk → disk → key.
    it.skipIf(bun || miniflare)(
      "invalidation walks through disk modules up to a virtual entry",
      async () => {
        let counter = 0;
        const entry = resolve(ghostDir, "entry.mjs");
        const lib = resolve(importersDir, "lib.mjs");
        runner = create({
          name: "virtual-disk-importers-virtual-entry",
          data: {
            entry,
            virtual: {
              [entry]: `import { count } from ${JSON.stringify(lib)};
                export default { fetch: () => Response.json({ count, evaluations: globalThis.__evaluations }) };`,
              "#count": () => `export default ${counter++};`,
            },
          },
        });
        await runner.waitForReady();
        expect(await state()).toEqual({ count: 0, evaluations: { lib: 1, deep: 1, shared: 1 } });

        await runner.invalidateModule!("#count");
        await runner.reloadModule!();
        expect(await state()).toEqual({ count: 1, evaluations: { lib: 2, deep: 2, shared: 1 } });
      },
    );
  });
}

// --- Runtime updates (`updateVirtualModules()`) ---

// Source of an expression importing `specifier`: its default export, or
// "missing" when the import fails (miniflare stubs an unresolvable bare import
// with an `undefined` default instead).
const importOrMissing = (specifier: string, pick = "m.default") =>
  `import(${JSON.stringify(specifier)}).then((m) => String(${pick} ?? "missing"), () => "missing")`;

for (const { name, create, skip, bun, deno, miniflare } of runners) {
  describe.skipIf(skip ?? false)(`${name} virtual module updates`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    const text = async () => (await runner.fetch("http://localhost/")).text();
    const valueEntry = (value: string) => ({
      "#entry": `import value from "#value";
        export default { fetch: () => new Response(String(value)) };`,
      "#value": `export default ${JSON.stringify(value)};`,
    });

    it("adds a `#` key that a failed importer picks up after reload", async () => {
      runner = create({
        name: "virtual-update-add",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default {
              fetch: async () => new Response(await ${importOrMissing("#mid", "m.value")}),
            };`,
            // Fails to link until `#new` exists.
            "#mid": `import value from "#new"; export { value };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("missing");
      await runner.updateVirtualModules!({ "#new": `export default "added";` });
      await runner.reloadModule!();
      expect(await text()).toBe("added");
    });

    it("adds a path key that a relative import finds, and removes it again", async () => {
      const entry = resolve(ghostDir, "entry.mjs");
      const dep = resolve(ghostDir, "dep.mjs");
      runner = create({
        name: "virtual-update-add-path",
        data: {
          entry,
          virtual: {
            [entry]: `export default {
              fetch: async () => new Response(await ${importOrMissing("./dep.mjs")}),
            };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("missing");
      await runner.updateVirtualModules!({ [dep]: `export default "added dep";` });
      await runner.reloadModule!();
      expect(await text()).toBe("added dep");
      // No file on disk: not found again.
      await runner.updateVirtualModules!({ [dep]: null });
      await runner.reloadModule!();
      expect(await text()).toBe("missing");
    });

    // Starts without `data.virtual`: the first update registers the backend.
    it("overrides a real file imported by the disk entry, and uncovers it on removal", async () => {
      const config = resolve(pathsDir, "config.mjs");
      runner = create({
        name: "virtual-update-override",
        data: { entry: resolve(pathsDir, "app.mjs") },
      });
      await runner.waitForReady();
      expect(await text()).toBe("disk config");
      await runner.updateVirtualModules!({ [config]: `export default "virtual config";` });
      await runner.reloadModule!();
      expect(await text()).toBe("virtual config");
      await runner.updateVirtualModules!({ [config]: null });
      await runner.reloadModule!();
      expect(await text()).toBe("disk config");
    });

    // The key was served under the file's own id first, so the real file must
    // come back under a fresh one.
    it("uncovers a real file overridden from the start on removal", async () => {
      const config = resolve(pathsDir, "config.mjs");
      runner = create({
        name: "virtual-update-uncover",
        data: {
          entry: resolve(pathsDir, "app.mjs"),
          virtual: { [config]: `export default "virtual config";` },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("virtual config");
      await runner.updateVirtualModules!({ [config]: null });
      await runner.reloadModule!();
      expect(await text()).toBe("disk config");
      await runner.updateVirtualModules!({ [config]: `export default "virtual again";` });
      await runner.reloadModule!();
      expect(await text()).toBe("virtual again");
    });

    it("overrides the disk entry itself, and restores it on removal", async () => {
      const entry = resolve(pathsDir, "app.mjs");
      runner = create({ name: "virtual-update-entry", data: { entry } });
      await runner.waitForReady();
      expect(await text()).toBe("disk config");
      await runner.updateVirtualModules!({
        [entry]: `export default { fetch: () => new Response("virtual entry") };`,
      });
      await runner.reloadModule!();
      expect(await text()).toBe("virtual entry");
      await runner.updateVirtualModules!({ [entry]: null });
      await runner.reloadModule!();
      expect(await text()).toBe("disk config");
    });

    it("replaces a string source reached through relative importers", async () => {
      const entry = resolve(ghostDir, "entry.mjs");
      const dep = resolve(ghostDir, "dep.mjs");
      runner = create({
        name: "virtual-update-replace",
        data: {
          entry,
          virtual: {
            [entry]: `import { value } from "./mid.mjs";
              export default { fetch: () => new Response(value) };`,
            [resolve(ghostDir, "mid.mjs")]: `export { default as value } from "./dep.mjs";`,
            [dep]: `export default "v1";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("v1");
      for (const value of ["v2", "v3"]) {
        await runner.updateVirtualModules!({ [dep]: `export default "${value}";` });
        await runner.reloadModule!();
        expect(await text()).toBe(value);
      }
    });

    it("removes a key so that importing it fails", async () => {
      runner = create({
        name: "virtual-update-remove",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default {
              fetch: async () => new Response(await ${importOrMissing("#gone")}),
            };`,
            "#gone": `export default "here";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("here");
      await runner.updateVirtualModules!({ "#gone": null });
      await runner.reloadModule!();
      expect(await text()).toBe("missing");
      await expect(runner.invalidateModule!("#gone")).rejects.toThrow('Cannot invalidate "#gone"');
    });

    it("applies a batch of changes in one round trip", async () => {
      runner = create({
        name: "virtual-update-batch",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `import a from "#a"; import b from "#b";
              export default { fetch: () => new Response(a + b) };`,
            "#a": `export default "a";`,
            "#b": `export default "b";`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("ab");
      let acks = 0;
      runner.onMessage((message: any) => {
        if (message?.event === "virtual-modules-updated") acks++;
      });
      await runner.updateVirtualModules!({
        "#entry": `import a from "#a"; import c from "#c";
          export default { fetch: () => new Response(a + c) };`,
        "#a": `export default "A";`,
        "#b": null,
        "#c": async () => `export default "C";`,
      });
      await runner.reloadModule!();
      expect(await text()).toBe("AC");
      // Miniflare applies updates on the host, without IPC.
      expect(acks).toBe(miniflare ? 0 : 1);
    });

    // Deno pre-transforms sources (see "resolves virtual TypeScript modules").
    it.skipIf(deno && !denoTypeStripping)("adds TypeScript and JSON modules", async () => {
      runner = create({
        name: "virtual-update-formats",
        data: {
          entry: "#entry",
          virtual: {
            "#entry": `export default {
              fetch: async () => new Response(
                (await ${importOrMissing("#util.ts")}) + ":" +
                (await ${importOrMissing("#data.json", "m.default?.value")}),
              ),
            };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("missing:missing");
      await runner.updateVirtualModules!({
        "#util.ts": `const value: string = "ts"; export default value;`,
        "#data.json": JSON.stringify({ value: "json" }),
      });
      await runner.reloadModule!();
      expect(await text()).toBe("ts:json");
    });

    it("re-runs a factory set by an update on invalidation", async () => {
      let counter = 0;
      runner = create({
        name: "virtual-update-factory",
        data: { entry: "#entry", virtual: valueEntry("static") },
      });
      await runner.waitForReady();
      expect(await text()).toBe("static");
      await runner.updateVirtualModules!({ "#value": () => `export default ${counter++};` });
      await runner.reloadModule!();
      expect(await text()).toBe("0");
      await runner.invalidateModule!("#value");
      await runner.reloadModule!();
      expect(await text()).toBe("1");
    });

    it("applies updates in call order, even behind a slower factory", async () => {
      runner = create({
        name: "virtual-update-order",
        data: { entry: "#entry", virtual: valueEntry("initial") },
      });
      await runner.waitForReady();
      const slow = runner.updateVirtualModules!({
        "#value": () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(`export default "slow";`), 100),
          ),
      });
      const fast = runner.updateVirtualModules!({ "#value": `export default "fast";` });
      await Promise.all([slow, fast]);
      await runner.reloadModule!();
      expect(await text()).toBe("fast");
    });

    it("applies an update made before the runner is ready", async () => {
      runner = create({
        name: "virtual-update-early",
        data: { entry: "#entry", virtual: valueEntry("initial") },
      });
      // No `waitForReady()`: the update waits for it, and so does the reload.
      const update = runner.updateVirtualModules!({ "#value": `export default "early";` });
      await runner.reloadModule!();
      await update;
      expect(await text()).toBe("early");
    });

    it("keeps update messages out of the entry's `ipc.onMessage`", async () => {
      runner = create({
        name: "virtual-update-ipc",
        data: { entry: resolve(_dir, "./fixtures/app-ipc-log.mjs") },
      });
      await runner.waitForReady();
      await runner.updateVirtualModules!({ "#unused": `export default 1;` });
      const reply = new Promise<any>((resolve) => {
        runner.onMessage((message: any) => {
          if (message?.type === "ipc-log-reply") resolve(message);
        });
      });
      runner.sendMessage({ type: "ipc-log" });
      expect((await reply).received).toEqual([{ type: "ipc-log" }]);
    });

    it("warns about an added path key naming the same file as a key", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Unique per runner: each pair only warns once per process.
      const file = resolve(ghostDir, `update-collision-${name}.mjs`);
      try {
        runner = create({
          name: "virtual-update-collision",
          data: { entry: "#entry", virtual: { ...valueEntry("ok"), [file]: `export default 1;` } },
        });
        await runner.waitForReady();
        await runner.updateVirtualModules!({ [pathToFileURL(file).href]: `export default 2;` });
        const warnings = warn.mock.calls.filter(([m]) => String(m).includes("same file"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]![0]).toContain(`"${file}" and "${pathToFileURL(file).href}"`);
      } finally {
        warn.mockRestore();
      }
    });

    it("never mutates the caller's `data.virtual`", async () => {
      const virtual = valueEntry("initial");
      const snapshot = { ...virtual };
      runner = create({ name: "virtual-update-options", data: { entry: "#entry", virtual } });
      await runner.waitForReady();
      await runner.updateVirtualModules!({ "#value": `export default "updated";`, "#new": "" });
      expect(virtual).toEqual(snapshot);
    });

    // Needs resolve hooks to observe disk importers (see "disk importers").
    it.skipIf(bun || miniflare)(
      "an added path key reaches disk modules importing the file it overrides",
      async () => {
        const config = resolve(pathsDir, "config.mjs");
        runner = create({
          name: "virtual-update-disk-importer",
          data: {
            entry: "#entry",
            virtual: {
              // `app.mjs` (disk) imports `./config.mjs` (disk).
              "#entry": `export { default } from ${JSON.stringify(resolve(pathsDir, "app.mjs"))};`,
            },
          },
        });
        await runner.waitForReady();
        expect(await text()).toBe("disk config");
        await runner.updateVirtualModules!({ [config]: `export default "virtual config";` });
        await runner.reloadModule!();
        expect(await text()).toBe("virtual config");
        await runner.updateVirtualModules!({ [config]: null });
        await runner.reloadModule!();
        expect(await text()).toBe("disk config");
      },
    );
  });
}

describe("MiniflareEnvRunner virtual module updates", () => {
  it("updates the instance shared by persistent runners, and evicts it from the cache", async () => {
    const text = async (runner: EnvRunner) => (await runner.fetch("http://localhost/")).text();
    const data = {
      entry: "#entry",
      virtual: {
        "#entry": `import value from "#value";
          export default { fetch: () => new Response(value) };`,
        "#value": `export default "initial";`,
      },
    };
    const create = () =>
      new MiniflareEnvRunner({
        miniflare,
        name: "virtual-update-persistent",
        persistent: true,
        data,
      });
    // Mirror a RunnerManager swap: the second runner attaches to the cached instance.
    const first = create();
    await first.waitForReady();
    const second = create();
    let third: MiniflareEnvRunner | undefined;
    try {
      await second.waitForReady();
      await first.close();
      // The update must reach the state the live fallback actually serves.
      await second.updateVirtualModules({ "#value": `export default "updated";` });
      await second.reloadModule();
      expect(await text(second)).toBe("updated");
      // The instance no longer matches the original sources: a fresh one.
      third = create();
      await third.waitForReady();
      expect(await text(third)).toBe("initial");
      expect(await text(second)).toBe("updated");
    } finally {
      await third?.close();
      await second.close();
      await first.close();
      await MiniflareEnvRunner.disposeAll();
    }
  });
});

describe("SelfEnvRunner virtual module updates", () => {
  it("rejects updateVirtualModules instead of leaking the IPC message to the entry", async () => {
    const { SelfEnvRunner } = await import("../src/runners/self/runner.ts");
    await using runner = new SelfEnvRunner({
      name: "self-update",
      data: { entry: resolve(_dir, "./fixtures/app.mjs") },
    });
    await runner.waitForReady();
    await expect(runner.updateVirtualModules({ "#x": "export default 1;" })).rejects.toThrow(
      "does not support virtual modules",
    );
  });
});

// --- Entry spelled differently from its path key ---

// A real `app.mjs` exists at the entry path; the virtual source must win on
// load and across reloads. Node/Deno only: Bun matches keys verbatim (and never
// matches `file:` keys), and miniflare reads `virtual[entry]`, so there the
// entry must be spelled exactly like its key.
for (const { name, create, skip, bun, miniflare } of runners) {
  describe.skipIf(skip || bun || miniflare)(`${name} virtual modules: entry spelling`, () => {
    let runner: EnvRunner;

    afterEach(async () => {
      await runner?.close();
    });

    const entryPath = resolve(pathsDir, "app.mjs");
    const entryURL = pathToFileURL(entryPath).href;
    const text = async () => (await runner.fetch("http://localhost/")).text();

    it("treats a path entry as its `file:` URL key on load and reload", async () => {
      let counter = 0;
      runner = create({
        name: "virtual-entry-path-for-url",
        data: {
          entry: entryPath,
          virtual: {
            [entryURL]: () =>
              `export default { fetch: () => new Response("virtual ${counter++}") };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe("virtual 0");
      await runner.reloadModule!();
      expect(await text()).toBe("virtual 0");
      // Invalidating the key refreshes the entry too.
      await runner.invalidateModule!(entryURL);
      await runner.reloadModule!();
      expect(await text()).toBe("virtual 1");
    });

    it("treats a `file:` URL entry as its path key on load and reload", async () => {
      runner = create({
        name: "virtual-entry-url-for-path",
        data: {
          entry: entryURL,
          virtual: {
            [entryPath]: `export default { fetch: () => new Response("virtual " + import.meta.filename) };`,
          },
        },
      });
      await runner.waitForReady();
      expect(await text()).toBe(`virtual ${entryPath}`);
      await runner.reloadModule!();
      expect(await text()).toBe(`virtual ${entryPath}`);
    });
  });
}

describe("virtual entry detection", async () => {
  const { isVirtualEntry, isVirtualSpecifier } = await import("../src/common/worker-utils.ts");
  const entryPath = resolve(pathsDir, "app.mjs");
  const entryURL = pathToFileURL(entryPath).href;

  it("matches exactly by default (miniflare, Bun)", () => {
    expect(isVirtualSpecifier(entryPath, { [entryPath]: "" })).toBe(true);
    expect(isVirtualSpecifier(entryPath, { [entryURL]: "" })).toBe(false);
    expect(isVirtualSpecifier(entryURL, { [entryPath]: "" })).toBe(false);
  });

  it("matches path keys by `file:` URL with `matchPaths`", () => {
    expect(isVirtualSpecifier(entryPath, { [entryURL]: "" }, true)).toBe(true);
    expect(isVirtualSpecifier(entryURL + "?x=1", { [entryPath]: "" }, true)).toBe(true);
    expect(isVirtualSpecifier(resolve(pathsDir, "config.mjs"), { [entryURL]: "" }, true)).toBe(
      false,
    );
    // Non-path keys stay exact.
    expect(isVirtualSpecifier("#entry?x=1", { "#entry": "" }, true)).toBe(false);
  });

  // vitest runs on Node, where `module.registerHooks` serves virtual modules.
  it("is path-aware for the worker entry under `registerHooks`", () => {
    expect(isVirtualEntry(entryPath, { [entryURL]: "" })).toBe(true);
    expect(isVirtualEntry(entryURL, { [entryPath]: "" })).toBe(true);
    expect(isVirtualEntry(entryPath, undefined)).toBe(false);
  });
});

// `registerHooks` (Node, Deno) serves non-path keys as `virtual:<key>`, encoding
// only what a URL parser would change, so the URL is readable and normalized.
describe("virtual: URLs of non-path keys", async () => {
  const { createVirtualHooks } = await import("../src/virtual-loader.ts");
  const next = (): any => ({ format: "module", source: "from next" });
  const load = (hooks: ReturnType<typeof createVirtualHooks>, url: string) =>
    hooks.load(url, { conditions: [], format: undefined, importAttributes: {} } as any, next)
      .source;
  const serve = (
    virtual: Record<string, string>,
    specifier: string,
    versions?: Map<string, number>,
  ) => {
    const hooks = createVirtualHooks(virtual, { versions });
    const { url } = hooks.resolve(specifier, { conditions: [], importAttributes: {} } as any, next);
    return { url, source: load(hooks, url) };
  };

  it("keeps the key readable and maps the URL back to it", () => {
    const cases = {
      "#config": "virtual:#config",
      "#config.json?raw": "virtual:#config.json?raw",
      "@scope/pkg/sub": "virtual:@scope/pkg/sub",
      "virtual:x": "virtual:virtual:x",
      "#a b%é": "virtual:#a%20b%25%C3%A9",
      '#<"`>': "virtual:#%3C%22%60%3E",
    };
    for (const [specifier, expected] of Object.entries(cases)) {
      const key = specifier.split("?")[0]!;
      const { url, source } = serve({ [key]: key }, specifier);
      expect(url).toBe(expected);
      expect(new URL(url).href).toBe(url);
      expect(source).toBe(key);
    }
  });

  it("keeps keys apart that only differ in escapes or fragments", () => {
    const virtual = { "#a": "1", "#a#b": "2", "%23a": "3", a: "4" };
    const served = Object.keys(virtual).map((key) => serve(virtual, key));
    expect(served.map(({ url }) => url)).toEqual([
      "virtual:#a",
      "virtual:#a#b",
      "virtual:%2523a",
      "virtual:a",
    ]);
    expect(served.map(({ source }) => source)).toEqual(["1", "2", "3", "4"]);
  });

  it("appends versions after the key and its query", () => {
    const versions = new Map([["#a", 2]]);
    expect(serve({ "#a": "1" }, "#a", versions)).toEqual({ url: "virtual:#a?v=2", source: "1" });
    expect(serve({ "#a": "1" }, "#a?raw", versions)).toEqual({
      url: "virtual:#a?raw&v=2",
      source: "1",
    });
  });

  it("passes other `virtual:` URLs on, even with malformed escapes", () => {
    const hooks = createVirtualHooks({ "#a": "1" });
    expect(load(hooks, "virtual:%zz")).toBe("from next");
    expect(load(hooks, "virtual:#b")).toBe("from next");
  });
});

describe("formatInitError", async () => {
  const { formatInitError } = await import("../src/common/worker-utils.ts");
  const error = (message: string, stack: string, name = "Error") =>
    Object.assign(new Error(message), { name, stack });

  it("appends the first stack frame with a location", () => {
    const frames = "\n    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)";
    expect(formatInitError(error("boom", `Error: boom\n    at virtual:#dep:2:7${frames}`))).toBe(
      "boom (at virtual:#dep:2:7)",
    );
    const json = "Error: bad\n    at JSON.parse (<anonymous>)\n    at fn (virtual:#dep.json:1:21)";
    expect(formatInitError(error("bad", json))).toBe("bad (at virtual:#dep.json:1:21)");
  });

  it("uses Node's failing line and Bun's syntax error position", () => {
    const message = "The requested module '#a' does not provide an export named 'x'";
    const stack = `virtual:#dep:1\nimport { x } from "#a";\n         ^\nSyntaxError: ${message}`;
    expect(formatInitError(error(message, stack, "SyntaxError"))).toBe(
      `${message} (at virtual:#dep:1)`,
    );
    const position = { file: "#dep", line: 1, column: 18 };
    expect(formatInitError({ name: "BuildMessage", message: "Unexpected ;", position })).toBe(
      "Unexpected ; (at #dep:1:18)",
    );
  });

  it("keeps messages that say where, env-runner's own and internal-only ones", () => {
    const located = "Unexpected token ';' at virtual:#dep:1:18";
    expect(
      formatInitError(error(located, `SyntaxError: ${located}\n    at async file:///w.mjs:1:1`)),
    ).toBe(located);
    const own = "[env-runner] Entry module must export a `fetch` handler";
    expect(
      formatInitError(error(own, `Error: ${own}\n    at resolveEntry (file:///w.mjs:1:1)`)),
    ).toBe(own);
    const internal =
      "SyntaxError: x\n    at compileSourceTextModule (node:internal/modules/esm/utils:1:1)";
    expect(formatInitError(error("x", internal, "SyntaxError"))).toBe("x");
    expect(formatInitError("plain")).toBe("plain");
  });
});

describe("warnVirtualPathCollisions", async () => {
  const { warnVirtualPathCollisions } = await import("../src/virtual-loader.ts");
  const warnings = (keys: string[]) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnVirtualPathCollisions(keys);
      return warn.mock.calls.map(([message]) => String(message));
    } finally {
      warn.mockRestore();
    }
  };
  const dir = resolve(ghostDir, "collisions");

  it("names both keys, once per pair", () => {
    const keys = [resolve(dir, "a.mjs"), pathToFileURL(resolve(dir, "a.mjs")).href + "?raw"];
    expect(warnings(keys)).toEqual([
      `[env-runner] virtual modules "${keys[0]}" and "${keys[1]}" name the same file; keep only one of them (which one is served depends on the runtime).`,
    ]);
    expect(warnings(keys)).toEqual([]);
    // Paths are normalized like the resolver does.
    expect(warnings([resolve(dir, "b.mjs"), `${dir}/../collisions/b.mjs`])).toHaveLength(1);
  });

  it("ignores distinct files, non-path keys and malformed `file:` URLs", () => {
    const keys = ["#c.mjs", "c.mjs", "./c.mjs", resolve(dir, "c.mjs"), resolve(dir, "d.mjs")];
    expect(warnings([...keys, "file://%zz/c.mjs", "file://%zz/c.mjs"])).toEqual([]);
  });
});

describe("MiniflareEnvRunner virtual module invalidation", () => {
  // Versioning rewrites import specifiers only (es-module-lexer), never
  // arbitrary string literals — code mentioning the key as plain data must
  // come through invalidation unchanged.
  it("does not rewrite string literals that merely mention an invalidated key", async () => {
    let counter = 0;
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-invalidate-literal",
      data: {
        entry: "#entry",
        virtual: {
          "#entry": `import config from "#config.json";
            const KEY = "#config.json";
            export default { fetch: () => new Response(KEY + ":" + config.count) };`,
          "#config.json": () => JSON.stringify({ count: counter++ }),
        },
      },
    });
    try {
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("#config.json:0");
      await runner.invalidateModule("#config.json");
      await runner.reloadModule();
      // The import picked up the fresh module; the data string is untouched.
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("#config.json:1");
    } finally {
      await runner.close();
    }
  });

  // Dynamic import specifiers are versioned too — including the template
  // literal form, whose offsets span the quotes (unlike a static import).
  it("rewrites a template-literal dynamic import specifier", async () => {
    let counter = 0;
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-invalidate-dynamic",
      data: {
        entry: "#entry",
        virtual: {
          "#entry": `const config = (await import(\`#config.json\`)).default;
            export default { fetch: () => new Response(String(config.count)) };`,
          "#config.json": () => JSON.stringify({ count: counter++ }),
        },
      },
    });
    try {
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("0");
      await runner.invalidateModule("#config.json");
      await runner.reloadModule();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("1");
    } finally {
      await runner.close();
    }
  });

  // workerd joins a `file:` specifier onto the referrer's directory; the
  // fallback redirects it to the key's path, so both spellings share a module.
  it("redirects `file:` imports of a path key to one module instance", async () => {
    let counter = 0;
    const entry = resolve(ghostDir, "entry.mjs");
    const dep = resolve(ghostDir, "dep.mjs");
    const count = resolve(ghostDir, "nested/count.mjs");
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-file-import",
      data: {
        entry,
        virtual: {
          [entry]: `import * as viaURL from ${JSON.stringify(pathToFileURL(dep).href)};
            import * as viaPath from "./dep.mjs";
            export default { fetch: () => new Response((viaURL === viaPath) + ":" + viaURL.count) };`,
          // A relative re-export from the redirected module.
          [dep]: `export { count } from "./nested/count.mjs";`,
          [count]: () => `export const count = ${counter++};`,
        },
      },
    });
    try {
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("true:0");
      // Versioned `file:` specifiers are redirected too.
      await runner.invalidateModule(count);
      await runner.reloadModule();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("true:1");
    } finally {
      await runner.close();
    }
  });

  // A disk module's relative imports resolve against its own path, so the
  // re-served entry versions its import of the overridden file.
  it("invalidates a path key imported relatively by the disk entry", async () => {
    let counter = 0;
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-disk-importer",
      data: {
        // `app.mjs` imports `./config.mjs`, which exists on disk too.
        entry: resolve(pathsDir, "app.mjs"),
        virtual: {
          [resolve(pathsDir, "config.mjs")]: () => `export default "config ${counter++}";`,
        },
      },
    });
    try {
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("config 0");
      await runner.invalidateModule(resolve(pathsDir, "config.mjs"));
      await runner.reloadModule();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("config 1");
    } finally {
      await runner.close();
    }
  });

  it("invalidation works across runners sharing a persistent instance", async () => {
    let counter = 0;
    const data = {
      entry: "#entry",
      virtual: {
        "#entry": `import config from "#config.json";
          export default { fetch: () => new Response(String(config.count)) };`,
        // Resolves to the same source for both runners so the cache key matches.
        "#config.json": () => JSON.stringify({ count: counter }),
      },
    };
    // Mirror a RunnerManager swap: the new runner attaches to the cached
    // instance first, then the old one closes (refCount stays > 0).
    const first = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-persistent",
      persistent: true,
      data,
    });
    await first.waitForReady();
    const second = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-persistent",
      persistent: true,
      data,
    });
    try {
      await second.waitForReady();
      await first.close();
      expect(await (await second.fetch("http://localhost/")).text()).toBe("0");
      // Invalidate through the runner that attached to the cached instance —
      // the fresh source must reach the maps the live fallback actually serves.
      counter = 1;
      await second.invalidateModule("#config.json");
      await second.reloadModule();
      expect(await (await second.fetch("http://localhost/")).text()).toBe("1");
    } finally {
      await second.close();
      await first.close();
      await MiniflareEnvRunner.disposeAll();
    }
  });
});

describe("MiniflareEnvRunner virtual entry exports", () => {
  // The wrapper statically re-exports DO/Entrypoint classes; the fallback
  // serves them at startup (miniflare v4 skips its on-disk ModuleLocator).
  it.each([
    { kind: "`#`", entry: "#entry", msg: "#msg" },
    { kind: "path-keyed", entry: resolve(ghostDir, "entry.mjs"), msg: "./msg.mjs" },
  ])("wires an auto-detected Durable Object of a $kind virtual entry", async ({ entry, msg }) => {
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "virtual-do",
      data: {
        entry,
        virtual: {
          [entry]: `import msg from ${JSON.stringify(msg)};
            export class Counter {
              constructor(state) { this.storage = state.storage; }
              async fetch() {
                const count = ((await this.storage.get("count")) || 0) + 1;
                await this.storage.put("count", count);
                return new Response(String(count));
              }
            }
            export default {
              async fetch(request, env) {
                const res = await env.COUNTER.get(env.COUNTER.idFromName("x")).fetch(request);
                return new Response(msg + ":" + (await res.text()));
              },
            };`,
          [msg.startsWith("#") ? msg : resolve(ghostDir, msg)]: `export default "count";`,
        },
      },
    });
    try {
      await runner.waitForReady();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("count:1");
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("count:2");
      await runner.reloadModule();
      expect(await (await runner.fetch("http://localhost/")).text()).toBe("count:3");
    } finally {
      await runner.close();
    }
  });
});

describe("SelfEnvRunner virtual module limitations", () => {
  it("rejects invalidateModule instead of leaking the IPC message to the entry", async () => {
    const { SelfEnvRunner } = await import("../src/runners/self/runner.ts");
    await using runner = new SelfEnvRunner({
      name: "self-invalidate",
      data: { entry: resolve(_dir, "./fixtures/app.mjs") },
    });
    await runner.waitForReady();
    await expect(runner.invalidateModule("#x")).rejects.toThrow("does not support virtual modules");
  });

  it("closes with a clear error instead of ignoring `data.virtual`", async () => {
    const { SelfEnvRunner } = await import("../src/runners/self/runner.ts");
    let closeCause: unknown;
    await using runner = new SelfEnvRunner({
      name: "self-virtual",
      hooks: {
        onClose: (_runner, cause) => {
          closeCause = cause;
        },
      },
      data: {
        entry: "#entry",
        virtual: { "#entry": `export default { fetch: () => new Response("unreachable") };` },
      },
    });
    expect(runner.closed).toBe(true);
    expect(String((closeCause as Error)?.message)).toContain("does not support virtual modules");
    await expect(runner.waitForReady()).rejects.toMatchObject({ cause: closeCause });
  });
});

// Subprocess-based: the vitest module runner intercepts in-process dynamic
// imports, so the fixture exercises the real ESM hook chain / Bun plugin.
describe("registerVirtualModules unregister", () => {
  const fixture = resolve(_dir, "./fixtures/virtual-unregister.mjs");

  it("deregisters the ESM hooks (registerHooks backend)", () => {
    const output = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
    expect(output.trim()).toBe("ok");
  });

  it.skipIf(!hasBun)("detaches the live source map (Bun.plugin backend)", () => {
    const output = execFileSync("bun", [fixture], { encoding: "utf8" });
    expect(output.trim()).toBe("ok");
  });
});

// Latest registration wins, each stays invalidatable, and unregistering one
// uncovers the older (subprocess-based, like the unregister fixture).
describe("registerVirtualModules stacking", () => {
  const fixture = resolve(_dir, "./fixtures/virtual-registrations.mjs");

  it("stacks registrations (registerHooks backend)", () => {
    const output = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
    expect(output.trim()).toBe("ok");
  });

  it.skipIf(!hasBun)("stacks registrations (Bun.plugin backend)", () => {
    const output = execFileSync("bun", [fixture], { encoding: "utf8" });
    expect(output.trim()).toBe("ok");
  });
});
