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
