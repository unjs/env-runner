import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import type { EnvRunner } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
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

const runners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  // Bun lacks `module.registerHooks()`; virtual modules use `Bun.plugin()` instead.
  {
    name: "BunProcessEnvRunner",
    create: (opts: any) => new BunProcessEnvRunner(opts),
    skip: !hasBun,
  },
  // Deno >= 2.x supports `module.registerHooks()`; skipped when deno is absent.
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
    create: (opts: any) => new MiniflareEnvRunner(opts),
    miniflare: true,
  },
];

for (const { name, create, skip, deno, miniflare } of runners) {
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
  });
}

describe("MiniflareEnvRunner virtual module limitations", () => {
  // The wrapper wires DO/Entrypoint exports as static re-exports, which
  // miniflare's ModuleLocator resolves on disk — impossible for a virtual entry.
  it("fails fast for named exports with a virtual entry", async () => {
    let closeCause: unknown;
    const runner = new MiniflareEnvRunner({
      name: "virtual-do",
      exports: { Counter: {} },
      hooks: {
        onClose: (_runner, cause) => {
          closeCause = cause;
        },
      },
      data: {
        entry: "#entry",
        virtual: {
          "#entry": `export default { fetch: () => new Response("unreachable") };`,
        },
      },
    });
    await expect(runner.waitForReady(3000)).rejects.toThrow();
    expect(runner.closed).toBe(true);
    expect(String((closeCause as Error)?.message)).toContain("virtual entry");
    await runner.close();
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
