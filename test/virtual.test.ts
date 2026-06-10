import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import type { EnvRunner } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDeno = hasRuntime("deno");

const _dir = dirname(fileURLToPath(import.meta.url));
const virtualAppEntry = resolve(_dir, "./fixtures/app-virtual.mjs");

const runners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  // Deno >= 2.x supports `module.registerHooks()`; skipped when deno is absent.
  {
    name: "DenoProcessEnvRunner",
    create: (opts: any) => new DenoProcessEnvRunner(opts),
    skip: !hasDeno,
  },
];

for (const { name, create, skip } of runners) {
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
