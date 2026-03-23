import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
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
    extraOpts: {},
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

    it("waitForReady resolves when runner becomes ready", async () => {
      runner = create(opts("test-wait-ready"));
      await runner.waitForReady();
      expect(runner.ready).toBe(true);
    });

    it("waitForReady resolves immediately if already ready", async () => {
      runner = create(opts("test-wait-ready-imm"));
      await waitForReady(runner);
      // Already ready — should resolve immediately
      await runner.waitForReady();
      expect(runner.ready).toBe(true);
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

// --- reloadModule tests ---

const reloadRunners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  {
    name: "BunProcessEnvRunner",
    create: (opts: any) => new BunProcessEnvRunner(opts),
    skip: !hasBun,
  },
  // SelfEnvRunner reloadModule works in real Node.js but not under vitest's module transform
];

for (const { name, create, skip } of reloadRunners) {
  describe.skipIf(skip ?? false)(`${name} reloadModule`, () => {
    let runner: EnvRunner | undefined;
    let tmpDir: string | undefined;

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    it("reloads entry module without restarting", async () => {
      tmpDir = mkdtempSync(join(_dir, ".tmp-reload-"));
      const entryPath = join(tmpDir, "app.mjs");

      writeFileSync(entryPath, `export default { fetch() { return new Response("v1"); } };`);

      runner = create({ name: "test-reload", data: { entry: entryPath } });
      await runner.waitForReady();

      const res1 = await runner.fetch("http://localhost/");
      expect(await res1.text()).toBe("v1");

      writeFileSync(entryPath, `export default { fetch() { return new Response("v2"); } };`);
      await runner.reloadModule!();

      const res2 = await runner.fetch("http://localhost/");
      expect(await res2.text()).toBe("v2");
    });

    it("re-initializes IPC hooks after reload", async () => {
      tmpDir = mkdtempSync(join(_dir, ".tmp-reload-"));
      const entryPath = join(tmpDir, "app.mjs");

      const makeEntry = (v: number) => `
let send;
export default {
  fetch() { return new Response("v${v}"); },
  ipc: {
    onOpen(ctx) { send = ctx.sendMessage; send({ type: "ready", version: ${v} }); },
    onMessage(msg) { if (msg?.type === "echo") send?.({ type: "echo-reply", version: ${v} }); },
    onClose() { send = undefined; },
  },
};`;

      writeFileSync(entryPath, makeEntry(1));
      runner = create({ name: "test-reload-ipc", data: { entry: entryPath } });

      const readyV1 = new Promise<any>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "ready" && msg.version === 1) resolve(msg);
        });
      });
      await runner.waitForReady();
      await readyV1;

      writeFileSync(entryPath, makeEntry(2));

      const readyV2 = new Promise<any>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "ready" && msg.version === 2) resolve(msg);
        });
      });
      await runner.reloadModule!();
      await readyV2;

      const reply = new Promise<any>((resolve) => {
        runner!.onMessage((msg: any) => {
          if (msg?.type === "echo-reply") resolve(msg);
        });
      });
      runner.sendMessage({ type: "echo" });
      expect(await reply).toEqual({ type: "echo-reply", version: 2 });
    });
  });
}

// --- upgrade tests ---

const appUpgradeEntry = resolve(_dir, "./fixtures/app-upgrade.mjs");

const upgradeRunners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
  {
    name: "SelfEnvRunner",
    create: (opts: any) => new SelfEnvRunner(opts),
    selfRunner: true,
  },
];

for (const { name, create, selfRunner } of upgradeRunners) {
  describe(`${name} upgrade`, () => {
    let runner: EnvRunner | undefined;

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
    });

    if (selfRunner) {
      it("calls entry.upgrade directly", async () => {
        runner = create({ name: "test-upgrade", data: { entry: appUpgradeEntry } });
        await runner.waitForReady();

        // For SelfEnvRunner, verify upgrade is callable with mock objects
        const { PassThrough } = await import("node:stream");
        const socket = new PassThrough();
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));

        const mockReq = {
          headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
        };

        runner.upgrade!({
          node: { req: mockReq as any, socket: socket as any, head: Buffer.alloc(0) },
        });

        await new Promise((r) => setTimeout(r, 50));
        const written = Buffer.concat(chunks).toString();
        expect(written).toContain("101 Switching Protocols");
      });
    } else {
      it("handles WebSocket upgrade via worker", async () => {
        let address: any;
        runner = create({
          name: "test-upgrade",
          data: { entry: appUpgradeEntry },
          hooks: {
            onReady: (_: any, addr: any) => {
              address = addr;
            },
          },
        });
        await runner.waitForReady();
        expect(address).toBeDefined();

        // Send an HTTP upgrade request to the worker's server directly
        const host = address.host || "127.0.0.1";
        const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
          const req = httpRequest({
            hostname: host,
            port: address.port,
            path: "/",
            headers: {
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
              Connection: "Upgrade",
              Upgrade: "websocket",
            },
          });
          req.on("upgrade", (res) => resolve(res));
          req.on("error", reject);
          req.end();
          setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
        });

        expect(res.headers["x-upgraded"]).toBe("true");
        res.socket?.destroy();
      });
    }
  });
}

// --- RPC tests ---

const appRpcEntry = resolve(_dir, "./fixtures/app-rpc.mjs");

const rpcRunners = [
  { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
  { name: "NodeProcessEnvRunner", create: (opts: any) => new NodeProcessEnvRunner(opts) },
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
  },
];

for (const { name, create, skip } of rpcRunners) {
  describe.skipIf(skip ?? false)(`${name} rpc`, () => {
    let runner: EnvRunner | undefined;

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
    });

    it("resolves with response data", async () => {
      runner = create({ name: "test-rpc", data: { entry: appRpcEntry } });
      await runner.waitForReady();

      const result = await runner.rpc<string>("greet", "world");
      expect(result).toBe("hello world");
    });

    it("rejects when worker returns an error", async () => {
      runner = create({ name: "test-rpc-error", data: { entry: appRpcEntry } });
      await runner.waitForReady();

      await expect(runner.rpc("fail")).rejects.toThrow("something went wrong");
    });

    it("rejects on timeout", async () => {
      runner = create({ name: "test-rpc-timeout", data: { entry: appRpcEntry } });
      await runner.waitForReady();

      // "slow" handler responds after 2s, so a 100ms timeout should fire first
      await expect(runner.rpc("slow", undefined, { timeout: 100 })).rejects.toThrow("timed out");
    });

    it("handles concurrent rpc calls", async () => {
      runner = create({ name: "test-rpc-concurrent", data: { entry: appRpcEntry } });
      await runner.waitForReady();

      const results = await Promise.all([
        runner.rpc<string>("greet", "a"),
        runner.rpc<string>("greet", "b"),
        runner.rpc<string>("greet", "c"),
      ]);
      expect(results).toEqual(["hello a", "hello b", "hello c"]);
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
