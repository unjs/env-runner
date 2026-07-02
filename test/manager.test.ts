import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { EnvRunner } from "../src/index.ts";
import { RunnerManager } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(_dir, "../src/runners/node-worker/worker.ts");
const appEntry = resolve(_dir, "./fixtures/app.mjs");

function createRunner(name: string) {
  return new NodeWorkerEnvRunner({ name, workerEntry, data: { entry: appEntry } });
}

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

describe("RunnerManager", () => {
  let manager: RunnerManager | undefined;
  let runners: EnvRunner[] = [];

  afterEach(async () => {
    await manager?.close();
    for (const r of runners) {
      if (!r.closed) await r.close();
    }
    manager = undefined;
    runners = [];
  });

  it("initializes without a runner", () => {
    manager = new RunnerManager();
    expect(manager.ready).toBe(false);
    expect(manager.closed).toBe(false);
  });

  it("initializes with a runner and proxies fetch", async () => {
    const runner = createRunner("init-fetch");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    expect(manager.ready).toBe(true);
    const res = await manager.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 503 when no runner is set", async () => {
    manager = new RunnerManager();
    const res = await manager.fetch("http://localhost/");
    expect(res.status).toBe(503);
  });

  it("reload swaps the active runner", async () => {
    const runner1 = createRunner("reload-1");
    const runner2 = createRunner("reload-2");
    runners.push(runner1, runner2);

    manager = new RunnerManager(runner1);
    await waitForReady(manager);
    expect(manager.ready).toBe(true);

    await manager.reload(runner2);
    await waitForReady(manager);

    expect(runner1.closed).toBe(true);
    expect(manager.ready).toBe(true);

    const res = await manager.fetch("http://localhost/");
    expect(res.status).toBe(200);
  });

  it("reload without a runner rejects (no runner factory)", async () => {
    const runner = createRunner("reload-no-arg");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    await expect(manager.reload()).rejects.toThrow("reload() requires a runner argument");

    // The active runner stays attached after a failed reload
    expect(manager.ready).toBe(true);
    const res = await manager.fetch("http://localhost/");
    expect(res.status).toBe(200);
  });

  it("fires onClose when runner exits", async () => {
    const runner = createRunner("on-close");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    const closed = new Promise<void>((resolve) => {
      manager!.onClose(() => resolve());
    });

    // Close the underlying runner directly to simulate unexpected exit
    await runner.close();
    await closed;
    expect(manager.ready).toBe(false);
  });

  it("fires onReady hook", async () => {
    const runner = createRunner("on-ready");
    runners.push(runner);
    manager = new RunnerManager();

    const ready = new Promise<void>((resolve) => {
      manager!.onReady(() => resolve());
    });

    await manager.reload(runner);
    await ready;
    expect(manager.ready).toBe(true);
  });

  it("queues messages and flushes on ready", async () => {
    const runner = createRunner("queue-msg");
    runners.push(runner);
    manager = new RunnerManager();

    // Send before any runner is attached — should queue
    manager.sendMessage({ type: "ping", data: "queued-1" });
    manager.sendMessage({ type: "ping", data: "queued-2" });

    const received: unknown[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      manager!.onMessage((msg: any) => {
        if (msg?.type === "pong") {
          received.push(msg);
          if (received.length >= 2) resolve();
        }
      });
    });

    await manager.reload(runner);
    await waitForReady(manager);

    await gotTwo;
    expect(received).toHaveLength(2);
    expect((received[0] as any).data).toBe("queued-1");
    expect((received[1] as any).data).toBe("queued-2");
  });

  it("proxies sendMessage when runner is ready", async () => {
    const runner = createRunner("send-msg");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    const pong = new Promise<any>((resolve) => {
      manager!.onMessage((msg: any) => {
        if (msg?.type === "pong") resolve(msg);
      });
    });

    manager.sendMessage({ type: "ping", data: "direct" });
    const msg = await pong;
    expect(msg.type).toBe("pong");
    expect(msg.data).toBe("direct");
  });

  it("onMessage/offMessage manage listeners across reloads", async () => {
    const runner1 = createRunner("listener-1");
    const runner2 = createRunner("listener-2");
    runners.push(runner1, runner2);

    manager = new RunnerManager(runner1);
    await waitForReady(manager);

    const messages: unknown[] = [];
    function waitForPong() {
      return new Promise<void>((resolve) => {
        manager!.onMessage(function _once(msg: any) {
          if (msg?.type === "pong") {
            manager!.offMessage(_once);
            resolve();
          }
        });
      });
    }
    const listener = (msg: any) => {
      if (msg?.type === "pong") messages.push(msg);
    };
    manager.onMessage(listener);

    const pong1 = waitForPong();
    manager.sendMessage({ type: "ping", data: "r1" });
    await pong1;
    expect(messages).toHaveLength(1);

    // Reload — listener should carry over
    await manager.reload(runner2);
    await waitForReady(manager);

    const pong2 = waitForPong();
    manager.sendMessage({ type: "ping", data: "r2" });
    await pong2;
    expect(messages).toHaveLength(2);

    // offMessage — no more messages
    manager.offMessage(listener);
    manager.sendMessage({ type: "ping", data: "r3" });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toHaveLength(2);
  });

  it("waitForReady resolves when runner becomes ready", async () => {
    const runner = createRunner("wait-ready");
    runners.push(runner);
    manager = new RunnerManager();

    // Start waiting before attaching runner
    const readyPromise = manager.waitForReady();
    await manager.reload(runner);
    await readyPromise;
    expect(manager.ready).toBe(true);
  });

  it("waitForReady resolves immediately if already ready", async () => {
    const runner = createRunner("wait-ready-immediate");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    // Should resolve immediately
    await manager.waitForReady();
    expect(manager.ready).toBe(true);
  });

  it("waitForReady rejects promptly when the manager closes mid-wait", async () => {
    manager = new RunnerManager();
    // No runner attached, so this would otherwise wait out the full timeout.
    const readyPromise = manager.waitForReady(15000);
    await manager.close();
    await expect(readyPromise).rejects.toThrow(/closed before becoming ready/);
  });

  it("supports `await using` disposal (Symbol.asyncDispose)", async () => {
    const runner = createRunner("async-dispose");
    runners.push(runner);
    {
      await using m = new RunnerManager(runner);
      manager = m;
      await waitForReady(m);
      expect(m.ready).toBe(true);
    }
    expect(manager.closed).toBe(true);
    expect(runner.closed).toBe(true);
  });

  it("close clears queue and shuts down runner", async () => {
    const runner = createRunner("close-cleanup");
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(manager);

    manager.sendMessage({ type: "ping", data: "before-close" });
    await manager.close();

    expect(manager.closed).toBe(true);
    expect(runner.closed).toBe(true);
  });

  function createVirtualCounterRunner(name: string, next: () => number) {
    return new NodeWorkerEnvRunner({
      name,
      workerEntry,
      data: {
        entry: "#entry",
        virtual: {
          "#entry": `import config from "#config.json";
            export default { fetch: () => new Response(String(config.count)) };`,
          "#config.json": () => JSON.stringify({ count: next() }),
        },
      },
    });
  }

  it("fetch after invalidateModule reloads the entry automatically", async () => {
    let counter = 0;
    const runner = createVirtualCounterRunner("manager-invalidate", () => counter++);
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(runner);

    let reloads = 0;
    manager.onMessage((msg: any) => {
      if (msg?.event === "module-reloaded") reloads++;
    });

    expect(await (await manager.fetch("http://localhost/")).text()).toBe("0");

    // No explicit reloadModule(): the pending invalidation flushes on fetch,
    // and concurrent fetches share a single reload.
    await manager.invalidateModule("#config.json");
    const [res1, res2] = await Promise.all([
      manager.fetch("http://localhost/"),
      manager.fetch("http://localhost/"),
    ]);
    expect(await res1.text()).toBe("1");
    expect(await res2.text()).toBe("1");
    expect(reloads).toBe(1);

    // Plain fetches don't reload again
    expect(await (await manager.fetch("http://localhost/")).text()).toBe("1");
    expect(reloads).toBe(1);
  });

  it("explicit reloadModule satisfies a pending invalidation", async () => {
    let counter = 0;
    const runner = createVirtualCounterRunner("manager-invalidate-explicit", () => counter++);
    runners.push(runner);
    manager = new RunnerManager(runner);
    await waitForReady(runner);

    let reloads = 0;
    manager.onMessage((msg: any) => {
      if (msg?.event === "module-reloaded") reloads++;
    });

    await manager.invalidateModule("#config.json");
    await manager.reloadModule();
    expect(reloads).toBe(1);

    // The explicit reload cleared the flag — fetch must not reload again
    expect(await (await manager.fetch("http://localhost/")).text()).toBe("1");
    expect(reloads).toBe(1);
  });
});
