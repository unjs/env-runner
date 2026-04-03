import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";
import type { EnvRunner } from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const workerDoEntry = resolve(_dir, "./fixtures/worker-do.mjs");

describe("MiniflareEnvRunner (custom exports)", () => {
  let runner: EnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it("supports Durable Object exports", async () => {
    runner = new MiniflareEnvRunner({
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
      name: "test-no-auto-do",
      data: { entry: workerDoEntry },
      exports: false,
    });
    await waitForReady(runner);

    // Without DO binding, accessing env.COUNTER will fail
    const res = await runner.fetch("http://localhost/counter/increment");
    expect(res.status).toBe(500);
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

  it("dispose() fully destroys persistent instance", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-persistent-"));
    const entryPath = join(tmpDir, "worker.mjs");

    writeFileSync(entryPath, `export default { fetch() { return new Response("ok"); } };`);

    const runner = new MiniflareEnvRunner({
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

// --- Helpers ---

function waitForReady(runner: EnvRunner, timeout = 5000): Promise<void> {
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
