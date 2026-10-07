import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const workerDoEntry = resolve(_dir, "./fixtures/worker-do.mjs");
const workerSrvxEntry = resolve(_dir, "./fixtures/worker-srvx.mjs");
const workerIpcRequestsEntry = resolve(_dir, "./fixtures/worker-ipc-requests.mjs");

describe("MiniflareEnvRunner (custom exports)", () => {
  let runner: EnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it("loads re-exported Durable Objects from a separate virtual module", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-virtual-exports",
      exports: "#server-exports",
      data: {
        entry: "#entry",
        virtual: {
          "#entry": `export { default } from ${JSON.stringify(workerDoEntry)};`,
          "#server-exports": async () =>
            `export { Counter as RenamedCounter } from ${JSON.stringify(workerDoEntry)};`,
        },
      },
      miniflareOptions: {
        durableObjects: { COUNTER: "RenamedCounter" },
      },
    });
    await runner.waitForReady();
    for (const count of [1, 2]) {
      const res = await runner.fetch("http://localhost/counter/increment");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count });
    }
    await runner.reloadModule!();
    expect(await (await runner.fetch("http://localhost/counter")).json()).toEqual({ count: 2 });
  });

  it("fetch waits for initialization instead of returning 503", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-fetch-before-ready",
      data: { entry: workerDoEntry },
      miniflareOptions: {
        durableObjects: {
          COUNTER: "Counter",
        },
      },
    });
    // No waitForReady — fetch must back off while init is in flight
    const res = await runner.fetch("http://localhost/counter");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it("accepts a module specifier for the `miniflare` option", async () => {
    runner = new MiniflareEnvRunner({
      miniflare: "miniflare",
      name: "test-miniflare-specifier",
      data: { entry: workerDoEntry },
      miniflareOptions: { durableObjects: { COUNTER: "Counter" } },
    });
    const res = await runner.fetch("http://localhost/counter");
    expect(res.status).toBe(200);
  });

  it("supports Durable Object exports", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-do",
      data: { entry: workerDoEntry },
      miniflareOptions: {
        durableObjects: {
          COUNTER: "Counter",
        },
      },
    });
    await waitForReady(runner);

    // Increment counter
    const res1 = await runner.fetch("http://localhost/counter/increment");
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ count: 1 });

    // Increment again
    const res2 = await runner.fetch("http://localhost/counter/increment");
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ count: 2 });

    // Read without increment
    const res3 = await runner.fetch("http://localhost/counter");
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ count: 2 });
  });

  it("preserves IPC alongside custom exports", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-do-ipc",
      data: { entry: workerDoEntry },
      miniflareOptions: {
        durableObjects: {
          COUNTER: "Counter",
        },
      },
    });

    const opened = new Promise<unknown>((resolve) => {
      runner!.onMessage((msg: any) => {
        if (msg?.type === "ipc:opened") resolve(msg);
      });
    });
    await waitForReady(runner);
    expect(await opened).toEqual({ type: "ipc:opened" });

    // IPC echo still works
    const reply = new Promise<unknown>((resolve) => {
      runner!.onMessage((msg: any) => {
        if (msg?.type === "echo-reply") resolve(msg);
      });
    });
    runner.sendMessage({ type: "echo", data: "with-do" });
    expect(await reply).toEqual({ type: "echo-reply", data: "with-do" });
  });
});

describe("MiniflareEnvRunner (srvx cloudflare context)", () => {
  let runner: EnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it("augments the request and applies middleware, plugins and error", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-srvx-context",
      data: { entry: workerSrvxEntry },
      miniflareOptions: { bindings: { FOO: "bar" } },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/", {
      headers: { "cf-connecting-ip": "198.51.100.7" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware")).toBe("1");
    expect(res.headers.get("x-plugin")).toBe("cloudflare");
    expect(await res.json()).toEqual({
      runtime: "cloudflare",
      runtimeEnvKeys: ["FOO"],
      hasContext: true,
      ip: "198.51.100.7",
      waitUntil: "function",
      envKeys: ["FOO"],
      envIsRuntimeEnv: true,
      ctx: "function",
    });

    const errRes = await runner.fetch("http://localhost/throw");
    expect(errRes.status).toBe(599);
    expect(await errRes.text()).toBe("handled: boom");
  });
});

describe("MiniflareEnvRunner (IPC across requests)", () => {
  let runner: EnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  // https://github.com/unjs/env-runner/issues/58
  it("sends messages from overlapping requests and streamed bodies", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-ipc-requests",
      data: { entry: workerIpcRequestsEntry },
    });
    await waitForReady(runner);
    const received: string[] = [];
    runner.onMessage((msg: any) => {
      if (msg?.type === "sent") received.push(msg.tag);
    });
    const text = async (path: string) => (await runner!.fetch(`http://localhost${path}`)).text();

    // `/fast` finishes while `/slow` is still in flight
    const slow = text("/slow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await text("/fast")).toBe("ok");
    expect(await slow).toBe("ok");

    // Body is produced after the wrapper's fetch() has returned
    expect(await text("/stream")).toBe("ok");

    await vi.waitFor(() => expect(received.sort()).toEqual(["fast", "slow", "stream"]));
  });
});

describe("MiniflareEnvRunner (hot-reload)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("reloads entry module without restarting miniflare", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-reload-"));
    const entryPath = join(tmpDir, "worker.mjs");

    // Write initial version
    writeFileSync(entryPath, `export default { fetch() { return new Response("v1"); } };`);

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-reload",
      data: { entry: entryPath },
    });
    await waitForReady(runner);

    // Verify initial response
    const res1 = await runner.fetch("http://localhost/");
    expect(await res1.text()).toBe("v1");

    // Update entry on disk
    writeFileSync(entryPath, `export default { fetch() { return new Response("v2"); } };`);

    // Hot-reload without restarting
    await runner.reloadModule();

    // Verify updated response
    const res2 = await runner.fetch("http://localhost/");
    expect(await res2.text()).toBe("v2");
  });

  it("re-initializes IPC hooks after reload", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-reload-"));
    const entryPath = join(tmpDir, "worker.mjs");

    // Write version with IPC
    writeFileSync(
      entryPath,
      `
let send;
export default {
  fetch() { return new Response("v1"); },
  ipc: {
    onOpen(ctx) { send = ctx.sendMessage; send({ type: "ready", version: 1 }); },
    onMessage(msg) { if (msg?.type === "ping-app") send?.({ type: "pong-app", version: 1 }); },
    onClose() { send = undefined; },
  },
};`,
    );

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-reload-ipc",
      data: { entry: entryPath },
    });

    const readyV1 = new Promise<any>((resolve) => {
      runner!.onMessage((msg: any) => {
        if (msg?.type === "ready" && msg.version === 1) resolve(msg);
      });
    });
    await waitForReady(runner);
    expect(await readyV1).toEqual({ type: "ready", version: 1 });

    // Update to v2
    writeFileSync(
      entryPath,
      `
let send;
export default {
  fetch() { return new Response("v2"); },
  ipc: {
    onOpen(ctx) { send = ctx.sendMessage; send({ type: "ready", version: 2 }); },
    onMessage(msg) { if (msg?.type === "ping-app") send?.({ type: "pong-app", version: 2 }); },
    onClose() { send = undefined; },
  },
};`,
    );

    const readyV2 = new Promise<any>((resolve) => {
      runner!.onMessage((msg: any) => {
        if (msg?.type === "ready" && msg.version === 2) resolve(msg);
      });
    });
    await runner.reloadModule();
    expect(await readyV2).toEqual({ type: "ready", version: 2 });

    // Verify IPC works with new entry
    const pong = new Promise<any>((resolve) => {
      runner!.onMessage((msg: any) => {
        if (msg?.type === "pong-app") resolve(msg);
      });
    });
    runner.sendMessage({ type: "ping-app" });
    expect(await pong).toEqual({ type: "pong-app", version: 2 });
  });
});

describe("MiniflareEnvRunner (transformRequest)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("transforms modules through the transform pipeline", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-transform-"));
    const helperPath = join(tmpDir, "helper.ts");
    const entryPath = join(tmpDir, "worker.mjs");

    // Write a TypeScript helper (would fail without transform)
    writeFileSync(helperPath, `const msg: string = "transformed"; export default msg;`);

    // Entry imports the helper
    writeFileSync(
      entryPath,
      `import msg from "./helper.ts";\nexport default { fetch() { return new Response(msg); } };`,
    );

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-transform",
      data: { entry: entryPath },
      transformRequest: async (id) => {
        if (id.endsWith(".ts")) {
          const { readFileSync } = await import("node:fs");
          const code = readFileSync(id, "utf8");
          // Simple TS→JS: strip type annotations
          return { code: code.replace(/:\s*string/g, "") };
        }
        return null;
      },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.text()).toBe("transformed");
  });

  it("falls back to raw disk read when transform returns null", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-transform-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { return new Response("raw"); } };`);

    const transformedIds: string[] = [];
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-transform-fallback",
      data: { entry: entryPath },
      transformRequest: async (id) => {
        transformedIds.push(id);
        return null; // Always fall back
      },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.text()).toBe("raw");
  });
});

describe("MiniflareEnvRunner (node_modules resolution)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeFiles(files: Record<string, string>) {
    tmpDir = mkdtempSync(join(_dir, ".tmp-node-modules-"));
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(tmpDir, path)), { recursive: true });
      writeFileSync(join(tmpDir, path), contents);
    }
    return tmpDir;
  }

  it("resolves conditional exports and require() from CommonJS packages", async () => {
    const dir = writeFiles({
      "node_modules/dual-pkg/package.json": JSON.stringify({
        name: "dual-pkg",
        exports: {
          ".": {
            node: { import: "./dist/node.mjs", require: "./dist/node.cjs" },
            default: { import: "./dist/default.mjs", require: "./dist/default.cjs" },
          },
        },
      }),
      "node_modules/dual-pkg/dist/node.mjs": `export const which = "node.mjs";`,
      "node_modules/dual-pkg/dist/node.cjs": `exports.which = "node.cjs";`,
      "node_modules/dual-pkg/dist/default.mjs": `export const which = "default.mjs";`,
      "node_modules/dual-pkg/dist/default.cjs": `exports.which = "default.cjs";`,
      "node_modules/cjs-pkg/package.json": JSON.stringify({
        name: "cjs-pkg",
        main: "dist/index.cjs",
      }),
      "node_modules/cjs-pkg/dist/index.cjs": [
        `const { which } = require("dual-pkg");`,
        `const { local } = require("./local.cjs");`,
        `module.exports = { nextTick: typeof require("node:process").nextTick, which, local };`,
      ].join("\n"),
      "node_modules/cjs-pkg/dist/local.cjs": `exports.local = "local.cjs";`,
      // Same basename as the package's file, next to the importer
      "src/deep/index.cjs": `exports.local = "wrong";`,
      "src/deep/other.mjs": `export * as dual from "dual-pkg";`,
      "src/deep/app.mjs": [
        `import { which } from "dual-pkg";`,
        `import * as dual from "dual-pkg";`,
        `import { dual as otherDual } from "./other.mjs";`,
        `import cjs from "cjs-pkg";`,
        `export default { fetch: () => Response.json({ which, cjs, same: dual === otherDual }) };`,
      ].join("\n"),
    });

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-node-modules",
      data: { entry: join(dir, "src/deep/app.mjs") },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toEqual({
      which: "default.mjs",
      cjs: { nextTick: "function", which: "default.cjs", local: "local.cjs" },
      same: true,
    });
  });

  it("serves a file a plugin resolves a CommonJS require() to under its path", async () => {
    const dir = writeFiles({
      "polyfill/node/process.mjs": `import { nextTick } from "../_internal/utils.mjs";\nexport default { nextTick };`,
      "polyfill/_internal/utils.mjs": `export const nextTick = () => {};`,
      "node_modules/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg", main: "index.cjs" }),
      "node_modules/cjs-pkg/index.cjs": `module.exports = typeof require("node:process").nextTick;`,
      "app.mjs": `import value from "cjs-pkg";\nexport default { fetch: () => new Response(value) };`,
    });
    const seen: string[] = [];
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-plugin-require",
      data: { entry: join(dir, "app.mjs") },
      plugins: [
        {
          resolveId: {
            filter: { id: /^node:process$/ },
            handler(source) {
              seen.push(source);
              return join(dir, "polyfill/node/process.mjs");
            },
          },
        },
      ],
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.text()).toBe("function");
    // Resolved once: the redirect's re-request reuses it.
    expect(seen).toEqual(["node:process"]);
  });

  it.each(["import", "require"])(
    "does not polyfill node: modules workerd lacks (%s)",
    async (method) => {
      const dir = writeFiles({
        // Not used, even when installed
        "node_modules/unenv/package.json": JSON.stringify({
          name: "unenv",
          exports: { "./node/*": "./node/*.mjs" },
        }),
        "node_modules/unenv/node/does_not_exist.mjs": `export default "polyfill";`,
        "node_modules/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg", main: "index.cjs" }),
        "node_modules/cjs-pkg/index.cjs": `module.exports = require("node:does_not_exist");`,
        "app.mjs": [
          method === "import"
            ? `import value from "node:does_not_exist";`
            : `import value from "cjs-pkg";`,
          `export default { fetch: () => new Response(value) };`,
        ].join("\n"),
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        runner = new MiniflareEnvRunner({
          miniflare,
          name: `test-node-builtin-${method}`,
          data: { entry: join(dir, "app.mjs") },
        });
        const cause = await runner.waitForReady().then(
          () => undefined,
          (error: Error) => error.cause as Error,
        );
        expect(cause?.message).toMatch(/No such module "node:does_not_exist"/);
      } finally {
        error.mockRestore();
      }
    },
  );
});

describe("MiniflareEnvRunner (auto-detect exports)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("auto-detects Durable Object exports and wires bindings", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-auto-do-"));
    const entryPath = join(tmpDir, "worker.mjs");

    // Entry uses the class name as the binding name (auto-detect convention)
    writeFileSync(
      entryPath,
      `
export class Counter {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const url = new URL(request.url);
    let value = (await this.storage.get("count")) || 0;
    if (url.pathname === "/increment") { value++; await this.storage.put("count", value); }
    return Response.json({ count: value });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/counter")) {
      const id = env.COUNTER.idFromName("test");
      const stub = env.COUNTER.get(id);
      const subPath = url.pathname.slice("/counter".length) || "/";
      return stub.fetch(new Request(new URL(subPath, url.origin), request));
    }
    return new Response("ok");
  },
};`,
    );

    // No manual durableObjects config — auto-detected from `export class Counter`
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-auto-do",
      data: { entry: entryPath },
    });
    await waitForReady(runner);

    const res1 = await runner.fetch("http://localhost/counter/increment");
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ count: 1 });

    const res2 = await runner.fetch("http://localhost/counter/increment");
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ count: 2 });
  });

  it("skips auto-detection when exports is false", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-no-auto-do",
      data: { entry: workerDoEntry },
      exports: false,
    });
    await waitForReady(runner);

    // Without DO binding, accessing env.COUNTER will fail
    const res = await runner.fetch("http://localhost/counter/increment");
    expect(res.status).toBe(500);
  });
  it("binds untyped explicit exports as Durable Objects", async () => {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-explicit-do",
      data: { entry: workerDoEntry },
      exports: { Counter: {} },
    });
    await waitForReady(runner);
    const res = await runner.fetch("http://localhost/counter/increment");
    expect(await res.json()).toEqual({ count: 1 });
  });

  it("doesn't scan the entry when the config declares classes", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-auto-do-"));
    const entryPath = join(tmpDir, "worker.mjs");
    writeFileSync(
      entryPath,
      `
export class Counter {}
export class Other {}
export default {
  fetch: (request, env) =>
    Response.json({ counter: typeof env.COUNTER?.idFromName, other: typeof env.OTHER }),
};`,
    );
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-auto-do-declared",
      data: { entry: entryPath },
      miniflareOptions: { durableObjects: { COUNTER: "Counter" } },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      counter: "function",
      other: "undefined",
    });
  });
});

describe("MiniflareEnvRunner (lazy exports)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeEntry(files: Record<string, string>): string {
    tmpDir ??= mkdtempSync(join(_dir, ".tmp-lazy-exports-"));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(tmpDir, name), contents);
    }
    return join(tmpDir, "worker.mjs");
  }

  const counterEntry = (version: string) => `
import { DurableObject } from "cloudflare:workers";
export { Counter } from "./counter.mjs";
import { hits } from "./counter.mjs";
export default {
  async fetch(request, env) {
    const stub = env.COUNTER.get(env.COUNTER.idFromName("test"));
    const url = new URL(request.url);
    if (url.pathname === "/rpc") return Response.json({ count: await stub.increment() });
    if (url.pathname === "/fetch") return stub.fetch(request);
    return Response.json({ hits: hits() });
  },
};
// ${version}
`;
  const counterModule = (version: string) => `
import { DurableObject } from "cloudflare:workers";
let _hits = 0;
export const hits = () => _hits;
export class Counter extends DurableObject {
  async increment() {
    _hits++;
    const count = ((await this.ctx.storage.get("count")) || 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
  fetch() {
    return new Response(${JSON.stringify(version)});
  }
}
`;

  it("resolves config-declared Durable Objects from the entry on use", async () => {
    const entryPath = writeEntry({
      "worker.mjs": counterEntry("v1"),
      "counter.mjs": counterModule("v1"),
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-do",
      data: { entry: entryPath },
      wrangler: {
        compatibility_date: "2025-01-01",
        durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
      },
      // Don't persist to the cwd's `.wrangler/state`.
      miniflareOptions: { defaultPersistRoot: undefined },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/rpc")).json()).toEqual({ count: 1 });
    expect(await (await runner.fetch("http://localhost/rpc")).json()).toEqual({ count: 2 });
    expect(await (await runner.fetch("http://localhost/fetch")).text()).toBe("v1");
    // The Durable Object shares the entry's module instance.
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({ hits: 2 });
  });

  it("follows reloadModule() without losing Durable Object state", async () => {
    // reloadModule() re-imports the entry only, so the class lives in it.
    const entry = (version: string) =>
      counterModule(version) +
      counterEntry(version).replace(/^import .*$|^export \{ Counter \}.*$/gm, "");
    const entryPath = writeEntry({ "worker.mjs": entry("v1") });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-do-reload",
      data: { entry: entryPath },
      miniflareOptions: {
        compatibilityDate: "2025-01-01",
        durableObjects: { COUNTER: { className: "Counter", useSQLite: true } },
      },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/rpc")).json()).toEqual({ count: 1 });
    expect(await (await runner.fetch("http://localhost/fetch")).text()).toBe("v1");

    writeEntry({ "worker.mjs": entry("v2") });
    await runner.reloadModule();

    expect(await (await runner.fetch("http://localhost/fetch")).text()).toBe("v2");
    expect(await (await runner.fetch("http://localhost/rpc")).json()).toEqual({ count: 2 });
    // Hits count in the reloaded module, which the Durable Object now uses.
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({ hits: 1 });
  });

  it("restarts with new stubs when a reload changes the entry's classes", async () => {
    const entry = (classes: string, fetch: string) => `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get("count")) || 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}
${classes}
export function helper() {}
export default {
  async fetch(request, env, ctx) {
    const counter = env.COUNTER.get(env.COUNTER.idFromName("test"));
    return Response.json({ count: await counter.increment(), helper: typeof env.HELPER, ${fetch} });
  },
};`;
    const entryPath = writeEntry({ "worker.mjs": entry("", "") });
    const reloaded: unknown[] = [];
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-restart",
      data: { entry: entryPath },
      miniflareOptions: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["enable_ctx_exports"],
      },
    });
    runner.onMessage((msg: any) => {
      if (msg?.event === "module-reloaded") reloaded.push(msg);
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      count: 1,
      helper: "undefined",
    });

    // Adds a Durable Object (auto-bound) and a WorkerEntrypoint.
    writeEntry({
      "worker.mjs": entry(
        `export class Other extends DurableObject {
  hello() { return "other"; }
}
class Greeter extends WorkerEntrypoint {
  greet(name) { return "hello " + name; }
}
export { Greeter as RenamedGreeter };`,
        `other: await env.OTHER.get(env.OTHER.idFromName("x")).hello(),
    greeting: await ctx.exports.RenamedGreeter.greet("world"),`,
      ),
    });
    await runner.reloadModule();
    expect(runner.ready).toBe(true);
    // Durable Object storage survives the restart.
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      count: 2,
      helper: "undefined",
      other: "other",
      greeting: "hello world",
    });

    // Removing them restarts again.
    writeEntry({ "worker.mjs": entry("", "other: typeof env.OTHER,") });
    await runner.reloadModule();
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      count: 3,
      helper: "undefined",
      other: "undefined",
    });
    expect(reloaded).toHaveLength(2);
  });

  it("detects classes of bundled entries, ignoring comments and strings", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { DurableObject as DurableObject2, WorkerEntrypoint } from "cloudflare:workers";
// export class Fake extends DurableObject2 {}
const text = "export class Str {}";
var Counter = class extends DurableObject2 {
  fetch() { return new Response("counter"); }
};
class Greeter extends WorkerEntrypoint {
  greet(name) { return "hello " + name; }
}
function helper() {}
var worker_default = {
  async fetch(request, env, ctx) {
    return Response.json({
      counter: await (await env.MY_COUNTER.get(env.MY_COUNTER.idFromName("x")).fetch(request)).text(),
      greeting: await ctx.exports.Greeter.greet("bundle"),
      greeter: typeof env.GREETER,
      fake: typeof env.FAKE,
      str: typeof env.STR,
      helper: typeof env.HELPER,
      text,
    });
  },
};
export { Counter as MyCounter, Greeter, helper, worker_default as default };`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-bundled",
      data: { entry: entryPath },
      miniflareOptions: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["enable_ctx_exports"],
      },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      counter: "counter",
      greeting: "hello bundle",
      greeter: "undefined",
      fake: "undefined",
      str: "undefined",
      helper: "undefined",
      text: "export class Str {}",
    });
  });

  it("resolves classes from the entry's resolveExports() hook", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { DurableObject } from "cloudflare:workers";
class CounterImpl extends DurableObject {
  fetch() { return new Response("from hook"); }
}
export default {
  resolveExports: async () => ({ Counter: CounterImpl }),
  fetch(request, env) {
    return env.COUNTER.get(env.COUNTER.idFromName("test")).fetch(request);
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-hook",
      data: { entry: entryPath },
      miniflareOptions: { durableObjects: { COUNTER: "Counter" } },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).text()).toBe("from hook");
  });

  it("stubs typed WorkerEntrypoint exports without binding them", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Greeter extends WorkerEntrypoint {
  greet(name) { return "hello " + name; }
}
export default {
  async fetch(request, env, ctx) {
    return Response.json({
      greeting: await ctx.exports.Greeter.greet("world"),
      bound: typeof env.GREETER,
    });
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-entrypoint",
      data: { entry: entryPath },
      exports: { Greeter: { type: "WorkerEntrypoint" } },
      miniflareOptions: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["enable_ctx_exports"],
      },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      greeting: "hello world",
      bound: "undefined",
    });
  });

  it("exports undeclared WorkerEntrypoints as stubs", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Greeter extends WorkerEntrypoint {
  greet(name) { return "hello " + name; }
}
export default {
  async fetch(request, env, ctx) {
    return Response.json({
      greeting: await ctx.exports.Greeter.greet("world"),
      bound: typeof env.GREETER,
    });
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-static-entrypoint",
      data: { entry: entryPath },
      miniflareOptions: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["enable_ctx_exports"],
      },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      greeting: "hello world",
      bound: "undefined",
    });
  });

  it("exports stubs under names that shadow the wrapper's globals", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { DurableObject } from "cloudflare:workers";
class Thing extends DurableObject {
  fetch() { return new Response("thing"); }
}
export { Thing as URL };
export default {
  fetch(request, env) {
    return env.THING.get(env.THING.idFromName("test")).fetch(request);
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-shadowing",
      data: { entry: entryPath },
      miniflareOptions: { durableObjects: { THING: "URL" } },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).text()).toBe("thing");
  });

  it("runs Workflows from the wrangler config", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class Doubler extends WorkflowEntrypoint {
  async run(event, step) {
    return step.do("double", async () => event.payload.value * 2);
  }
}
export default {
  async fetch(request, env) {
    const instance = await env.WORKFLOW.create({ params: { value: 21 } });
    for (let i = 0; i < 100; i++) {
      const status = await instance.status();
      if (status.status === "complete" || status.status === "errored") {
        return Response.json({ ...status, autoBound: typeof env.DOUBLER });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("timeout", { status: 504 });
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-workflow",
      data: { entry: entryPath },
      wrangler: {
        compatibility_date: "2025-01-01",
        workflows: [{ binding: "WORKFLOW", name: "doubler", class_name: "Doubler" }],
      },
      miniflareOptions: { defaultPersistRoot: undefined },
    });
    await waitForReady(runner);
    const res = await runner.fetch("http://localhost/");
    expect(await res.json()).toMatchObject({
      status: "complete",
      output: 42,
      autoBound: "undefined",
    });
  });

  it("reports a Workflow class without run()", async () => {
    const entryPath = writeEntry({
      "worker.mjs": `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class Doubler extends WorkflowEntrypoint {}
export default {
  async fetch(request, env) {
    const instance = await env.WORKFLOW.create();
    for (let i = 0; i < 100; i++) {
      const status = await instance.status();
      if (status.status === "complete" || status.status === "errored") {
        return Response.json(status);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return new Response("timeout", { status: 504 });
  },
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-workflow-run",
      data: { entry: entryPath },
      wrangler: {
        compatibility_date: "2025-01-01",
        workflows: [{ binding: "WORKFLOW", name: "doubler", class_name: "Doubler" }],
      },
      miniflareOptions: { defaultPersistRoot: undefined },
    });
    await waitForReady(runner);
    const status = await (await runner.fetch("http://localhost/")).json();
    expect(status).toMatchObject({ status: "errored" });
    expect(JSON.stringify(status)).toContain(
      'Expected \\"Doubler\\" export of the entry to define a `run()` method.',
    );
  });

  // The stubs are inlined with `Function.prototype.toString()`, so run them
  // from the bundled `dist` too (built before the tests, see global setup).
  it("runs the export stubs from the built package", async () => {
    const { MiniflareEnvRunner: BuiltRunner } =
      await import("../dist/runners/miniflare/runner.mjs");
    const entryPath = writeEntry({
      "worker.mjs": `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get("count")) || 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}
export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return "hello " + name;
  }
}
export default {
  async fetch(request, env, ctx) {
    const stub = env.COUNTER.get(env.COUNTER.idFromName("test"));
    return Response.json({
      count: await stub.increment(),
      greeting: await ctx.exports.Greeter.greet("dist"),
    });
  },
};`,
    });
    runner = new BuiltRunner({
      miniflare,
      name: "test-lazy-dist",
      data: { entry: entryPath },
      wrangler: {
        compatibility_date: "2025-01-01",
        compatibility_flags: ["enable_ctx_exports"],
        durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
        exports: { Greeter: { type: "worker" } },
      },
      miniflareOptions: { defaultPersistRoot: undefined },
    }) as unknown as MiniflareEnvRunner;
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).json()).toEqual({
      count: 1,
      greeting: "hello dist",
    });
  });

  it("warns about missing and undeclared Worker exports", async () => {
    const warnings: string[] = [];
    const capture = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(capture);
    const entryPath = writeEntry({
      "helper.mjs": `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Undeclared extends WorkerEntrypoint {}`,
      "worker.mjs": `
export { Undeclared } from "./helper.mjs";
export default {
  fetch: (req, env) =>
    new URL(req.url).pathname === "/missing"
      ? env.MISSING.get(env.MISSING.idFromName("x")).fetch(req)
      : new Response("ok"),
};`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-warnings",
      data: { entry: entryPath },
      miniflareOptions: { durableObjects: { MISSING: "Missing" } },
    });
    await waitForReady(runner);
    expect(await (await runner.fetch("http://localhost/")).text()).toBe("ok");
    await vi.waitFor(() => {
      const text = warnings.join("\n");
      expect(text).toContain('"Missing" is declared as a DurableObject but not exported');
      expect(text).toContain('"Undeclared" extends WorkerEntrypoint but is not declared');
    });
    const { error } = await (await runner.fetch("http://localhost/missing")).json();
    expect(error).toBe(
      '"Missing" is declared as a DurableObject but the entry does not export it.',
    );
  });

  it("doesn't warn about a default export extending WorkerEntrypoint", async () => {
    const warnings: string[] = [];
    const capture = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(capture);
    const entryPath = writeEntry({
      "worker.mjs": `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {}`,
    });
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-lazy-default",
      data: { entry: entryPath },
      miniflareOptions: { durableObjects: { MISSING: "Missing" } },
    });
    await waitForReady(runner);
    await vi.waitFor(() => {
      expect(warnings.join("\n")).toContain('"Missing" is declared');
    });
    expect(warnings.join("\n")).not.toContain('"default"');
  });
});

describe("MiniflareEnvRunner (error capture)", () => {
  let runner: MiniflareEnvRunner | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("returns structured JSON error when fetch throws", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-error-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { throw new Error("test boom"); } };`);

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-error-capture",
      data: { entry: entryPath },
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Env-Runner-Error")).toBe("1");
    const body = await res.json();
    expect(body.error).toBe("test boom");
    expect(body.name).toBe("Error");
    expect(body.stack).toBeTruthy();
  });

  it("does not capture errors when captureErrors is false", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-error-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { throw new Error("raw boom"); } };`);

    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-no-capture",
      data: { entry: entryPath },
      captureErrors: false,
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    // Without capture, workerd returns its own 500 error (not our structured one)
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Env-Runner-Error")).toBeNull();
  });
});

describe("MiniflareEnvRunner (persistent)", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    await MiniflareEnvRunner.disposeAll();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("reuses Miniflare instance across runner swaps", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-persistent-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { return new Response("v1"); } };`);

    const runner1 = new MiniflareEnvRunner({
      miniflare,
      name: "test-persistent-1",
      data: { entry: entryPath },
      persistent: true,
    });
    await waitForReady(runner1);

    const res1 = await runner1.fetch("http://localhost/");
    expect(await res1.text()).toBe("v1");

    // Close runner1 (but Miniflare stays alive due to persistent mode)
    await runner1.close();

    // Update entry
    writeFileSync(entryPath, `export default { fetch() { return new Response("v2"); } };`);

    // Create runner2 with same config — should reuse Miniflare instance
    const runner2 = new MiniflareEnvRunner({
      miniflare,
      name: "test-persistent-2",
      data: { entry: entryPath },
      persistent: true,
    });
    await waitForReady(runner2);

    // New WebSocket IPC is established, entry is reloaded
    const res2 = await runner2.fetch("http://localhost/");
    expect(await res2.text()).toBe("v2");

    await runner2.close();
  });

  it("routes IPC messages to the runner that reuses the instance", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-persistent-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { return new Response("ok"); } };`);

    const runner1 = new MiniflareEnvRunner({
      miniflare,
      name: "test-persistent-ipc-1",
      data: { entry: entryPath },
      persistent: true,
    });
    await waitForReady(runner1);
    // A user request makes the worker send over the IPC binding from now on
    await (await runner1.fetch("http://localhost/")).text();

    // Hot-swap: runner2 attaches to the shared instance before runner1 closes
    const runner2 = new MiniflareEnvRunner({
      miniflare,
      name: "test-persistent-ipc-2",
      data: { entry: entryPath },
      persistent: true,
    });
    await waitForReady(runner2);
    await runner1.close();

    // `module-reloaded` must reach runner2, not the closed runner1
    await runner2.reloadModule(2000);

    await runner2.close();
  });

  it("shares classes detected after a reload with runners reusing the instance", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-persistent-"));
    const entryPath = join(tmpDir, "worker.mjs");
    const entry = (classes: string) => `
import { DurableObject } from "cloudflare:workers";
${classes}
export default {
  fetch: async (request, env) =>
    Response.json({ other: env.OTHER && (await env.OTHER.get(env.OTHER.idFromName("x")).hello()) }),
};`;
    writeFileSync(entryPath, entry(""));
    const options = {
      miniflare,
      data: { entry: entryPath },
      persistent: true,
      miniflareOptions: { compatibilityDate: "2025-01-01" },
    };

    const runner1 = new MiniflareEnvRunner({ name: "test-persistent-restart-1", ...options });
    await waitForReady(runner1);
    writeFileSync(
      entryPath,
      entry(`export class Other extends DurableObject { hello() { return "other"; } }`),
    );
    await runner1.reloadModule();
    expect(await (await runner1.fetch("http://localhost/")).json()).toEqual({ other: "other" });
    await runner1.close();

    // Detects the class at startup too, adopting the restarted instance.
    const runner2 = new MiniflareEnvRunner({ name: "test-persistent-restart-2", ...options });
    await waitForReady(runner2);
    expect(await (await runner2.fetch("http://localhost/")).json()).toEqual({ other: "other" });
    await runner2.reloadModule();
    expect(await (await runner2.fetch("http://localhost/")).json()).toEqual({ other: "other" });
    await runner2.close();
  });

  it("dispose() fully destroys persistent instance", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-persistent-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { return new Response("ok"); } };`);

    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-dispose",
      data: { entry: entryPath },
      persistent: true,
    });
    await waitForReady(runner);

    const res = await runner.fetch("http://localhost/");
    expect(await res.text()).toBe("ok");

    await runner.dispose();
    expect(runner.closed).toBe(true);
  });
});

describe("MiniflareEnvRunner (explicit miniflare dependency)", () => {
  it("falls back to importing `miniflare` when the option is omitted", async () => {
    const runner = new MiniflareEnvRunner({ name: "no-option", data: { entry: workerDoEntry } });
    try {
      await waitForReady(runner);
      expect(runner.ready).toBe(true);
    } finally {
      await runner.close();
    }
  });

  it("closes with a clear error when the passed module is not miniflare", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runner = new MiniflareEnvRunner({
        name: "bad-module",
        miniflare: {} as any,
        data: { entry: workerDoEntry },
      });
      await expect(waitForReady(runner, 2000)).rejects.toThrow();
      expect(runner.closed).toBe(true);
      expect(String(error.mock.calls[0]?.[1])).toMatch(/does not export `Miniflare`/);
    } finally {
      error.mockRestore();
    }
  });

  it("uses the passed module instead of importing `miniflare` itself", async () => {
    let seen: unknown;
    const spy = {
      ...miniflare,
      Miniflare: class extends miniflare.Miniflare {
        constructor(options: any) {
          seen = options;
          super(options);
        }
      },
    };
    const runner = new MiniflareEnvRunner({
      name: "injected",
      miniflare: spy as any,
      data: { entry: workerDoEntry },
    });
    try {
      await waitForReady(runner);
      expect(seen).toBeTruthy();
      expect((await (await runner.fetch("http://localhost/")).text()).length).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
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
