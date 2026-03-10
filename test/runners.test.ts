import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { EnvRunner } from "../src/index.ts";
import {
  NodeWorkerEnvRunner,
  NodeProcessEnvRunner,
  BunProcessEnvRunner,
  SelfEnvRunner,
} from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.ts");

const runners = [
  {
    name: "NodeWorkerEnvRunner",
    create: (opts: any) => new NodeWorkerEnvRunner(opts),
  },
  {
    name: "NodeProcessEnvRunner",
    create: (opts: any) => new NodeProcessEnvRunner(opts),
  },
  {
    name: "BunProcessEnvRunner",
    create: (opts: any) => new BunProcessEnvRunner(opts),
  },
  {
    name: "SelfEnvRunner",
    create: (opts: any) => new SelfEnvRunner(opts),
  },
];

for (const { name, create } of runners) {
  describe(name, () => {
    let runner: EnvRunner | undefined;

    const opts = (testName: string, extra?: Record<string, unknown>) => ({
      name: testName,
      data: { entry: appEntry },
      ...extra,
    });

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
    });

    it("starts and becomes ready", async () => {
      runner = create(opts("test"));
      await waitForReady(runner);
      expect(runner.ready).toBe(true);
      expect(runner.closed).toBe(false);
    });

    it("fetches from runner", async () => {
      runner = create(opts("test-fetch"));
      await waitForReady(runner);

      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });

    it("fetches with POST body", async () => {
      runner = create(opts("test-post"));
      await waitForReady(runner);

      const res = await runner.fetch("http://localhost/echo", {
        method: "POST",
        body: "hello",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.method).toBe("POST");
      expect(data.body).toBe("hello");
    });

    it("sends and receives messages", async () => {
      runner = create(opts("test-msg"));
      await waitForReady(runner);

      const received = new Promise<unknown>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "pong") {
            resolve(msg);
          }
        });
      });

      runner.sendMessage({ type: "ping", data: "test-payload" });
      const msg: any = await received;
      expect(msg.type).toBe("pong");
      expect(msg.data).toBe("test-payload");
    });

    it("offMessage removes listener", async () => {
      runner = create(opts("test-off"));
      await waitForReady(runner);

      const messages: unknown[] = [];
      const listener = (msg: unknown) => messages.push(msg);

      runner.onMessage(listener);
      runner.offMessage(listener);

      runner.sendMessage({ type: "ping", data: "should-not-receive" });
      await new Promise((r) => setTimeout(r, 50));
      expect(messages.filter((m: any) => m?.type === "pong")).toHaveLength(0);
    });

    it("closes gracefully", async () => {
      runner = create(opts("test-close"));
      await waitForReady(runner);
      expect(runner.closed).toBe(false);

      await runner.close();
      expect(runner.closed).toBe(true);
      expect(runner.ready).toBe(false);
      runner = undefined;
    });

    it("calls onClose hook", async () => {
      let closeCalled = false;
      runner = create(
        opts("test-hooks", {
          hooks: {
            onClose: () => {
              closeCalled = true;
            },
          },
        }),
      );
      await waitForReady(runner);

      await runner.close();
      expect(closeCalled).toBe(true);
      runner = undefined;
    });

    it("calls onReady hook", async () => {
      const readyPromise = new Promise<void>((resolve) => {
        runner = create(
          opts("test-ready-hook", {
            hooks: {
              onReady: () => resolve(),
            },
          }),
        );
      });
      await readyPromise;
      expect(runner!.ready).toBe(true);
    });

    it("returns 503 when unavailable", async () => {
      runner = create({
        name: "test-unavailable",
        workerEntry: "/non/existent/path.js",
      });
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(503);
    });

    it("inspect returns formatted string", async () => {
      runner = create(opts("test-inspect"));
      const pending = inspect(runner);
      expect(pending).toContain("pending");

      await waitForReady(runner);
      const ready = inspect(runner);
      expect(ready).toContain("ready");

      await runner.close();
      const closed = inspect(runner);
      expect(closed).toContain("closed");
      runner = undefined;
    });
  });
}

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
