import { execFileSync } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { EnvRunner } from "../src/index.ts";

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasBun = hasRuntime("bun");
const hasDeno = hasRuntime("deno");

import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

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
    skip: !hasBun,
  },
  {
    name: "DenoProcessEnvRunner",
    create: (opts: any) => new DenoProcessEnvRunner(opts),
    skip: !hasDeno,
  },
  {
    name: "SelfEnvRunner",
    create: (opts: any) => new SelfEnvRunner(opts),
  },
  {
    name: "MiniflareEnvRunner",
    create: (opts: any) => new MiniflareEnvRunner(opts),
    skipWorkerEntry: true,
    extraOpts: { miniflareOptions: { compatibilityDate: "2024-01-01" } },
  },
];

for (const runnerDef of runners) {
  const { name, create, entry, skip, skipWorkerEntry, extraOpts } = {
    entry: appEntry,
    skip: false,
    skipWorkerEntry: false,
    extraOpts: {} as Record<string, unknown>,
    ...runnerDef,
  };
  describe.skipIf(skip)(name, () => {
    let runner: EnvRunner | undefined;

    const opts = (testName: string, extra?: Record<string, unknown>) => ({
      name: testName,
      data: { entry },
      ...extraOpts,
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

    it.skipIf(skipWorkerEntry)("returns 503 when unavailable", async () => {
      runner = create({
        name: "test-unavailable",
        workerEntry: "/non/existent/path.js",
      });
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(503);
    });

    it("ipc.onOpen sends message on ready", async () => {
      runner = create(opts("test-ipc-open"));
      // Register listener before ready since onOpen fires before the address message
      const opened = new Promise<unknown>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "ipc:opened") {
            resolve(msg);
          }
        });
      });
      await waitForReady(runner!);
      const msg = await opened;
      expect(msg).toEqual({ type: "ipc:opened" });
    });

    it("ipc.onMessage receives and replies", async () => {
      runner = create(opts("test-ipc-msg"));
      // Register reply listener before ready to not miss any messages
      const reply = new Promise<unknown>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "echo-reply") {
            resolve(msg);
          }
        });
      });
      await waitForReady(runner!);

      runner!.sendMessage({ type: "echo", data: "hello-ipc" });
      const msg: any = await reply;
      expect(msg).toEqual({ type: "echo-reply", data: "hello-ipc" });
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
