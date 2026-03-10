import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
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
        compatibilityDate: "2024-01-01",
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
        compatibilityDate: "2024-01-01",
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
