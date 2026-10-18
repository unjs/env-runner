import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as miniflare from "miniflare";
import type { EnvRunner } from "../src/index.ts";
import { RunnerManager } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";

function hasCommand(cmd: string, args = ["--version"]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasBun = hasCommand("bun");
const hasDeno = hasCommand("deno");
const hasOpenSSL = hasCommand("openssl", ["version"]);

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");
const appShutdownEntry = resolve(_dir, "./fixtures/app-shutdown.mjs");
const appWebSocketEntry = resolve(_dir, "./fixtures/app-websocket.mjs");

const runners = [
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
];

// A self-signed certificate for `127.0.0.1`.
let tls: { cert: string; key: string } | undefined;
let tlsDir: string | undefined;
beforeAll(() => {
  if (!hasOpenSSL) {
    return;
  }
  tlsDir = mkdtempSync(join(tmpdir(), "env-runner-tls-"));
  const cert = join(tlsDir, "cert.pem");
  const key = join(tlsDir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  tls = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
});
afterAll(() => {
  if (tlsDir) {
    rmSync(tlsDir, { recursive: true, force: true });
  }
});

for (const { name, create, skip } of runners) {
  describe.skipIf(skip ?? false)(`${name} listen`, () => {
    let runner: EnvRunner | undefined;

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
    });

    it("serves on the public address, and through the host", async () => {
      runner = create({
        name: "listen",
        data: { entry: appEntry },
        listen: { port: 0, hostname: "127.0.0.1" },
      });
      await runner.waitForReady();
      const { host, port, protocol } = runner.address!;
      expect(host).toBe("127.0.0.1");
      expect(port).toBeGreaterThan(0);
      expect(protocol).toBeUndefined();

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe("ok");
      expect(await (await runner.fetch("/")).text()).toBe("ok");
    });

    it("reports a wildcard hostname as loopback", async () => {
      runner = create({
        name: "listen-wildcard",
        data: { entry: appEntry },
        listen: { port: 0, hostname: "0.0.0.0" },
      });
      await runner.waitForReady();
      expect(runner.address?.host).toBe("127.0.0.1");
      expect(await (await runner.fetch("/")).text()).toBe("ok");
    });

    it("listens on the `PORT` env var by default", async () => {
      // Unset `PORT` in the test env would mean 3000, which may be taken.
      const port = await freePort();
      const previous = process.env.PORT;
      process.env.PORT = String(port);
      try {
        runner = create({ name: "listen-env", data: { entry: appEntry }, listen: {} });
        await runner.waitForReady();
      } finally {
        if (previous === undefined) {
          delete process.env.PORT;
        } else {
          process.env.PORT = previous;
        }
      }
      expect(runner.address?.port).toBe(port);
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("ok");
    });

    it("upgrades WebSockets on the public address", async () => {
      runner = create({
        name: "listen-ws",
        data: { entry: appWebSocketEntry },
        listen: { port: 0, hostname: "127.0.0.1" },
      });
      await runner.waitForReady();
      const ws = new WebSocket(`ws://127.0.0.1:${runner.address!.port}/_ws`);
      const message = await new Promise<string>((resolve, reject) => {
        ws.addEventListener("message", (event) => resolve(String(event.data)));
        ws.addEventListener("error", () => reject(new Error("WebSocket error")));
      });
      ws.close();
      expect(message).toBe("welcome");
    });

    it.skipIf(!hasOpenSSL)("serves HTTPS with `tls`, also through the host", async () => {
      runner = create({
        name: "listen-tls",
        data: { entry: appEntry },
        listen: { port: 0, hostname: "127.0.0.1", tls },
      });
      await runner.waitForReady();
      const { port, protocol } = runner.address!;
      expect(protocol).toBe("https");

      const body = await new Promise<string>((resolve, reject) => {
        httpsRequest({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        })
          .on("error", reject)
          .end();
      });
      expect(body).toBe("ok");
      expect(await (await runner.fetch("/")).text()).toBe("ok");
    });

    it("closes with the listen error when the port is taken", async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        let cause: unknown;
        runner = create({
          name: "listen-in-use",
          data: { entry: appEntry },
          listen: { port, hostname: "127.0.0.1" },
          hooks: {
            onClose: (_runner: EnvRunner, closeCause: unknown) => {
              cause = closeCause;
            },
          },
        });
        await expect(runner.waitForReady()).rejects.toThrow("Runner closed before becoming ready");
        // Node.js: `EADDRINUSE: address already in use`, Bun: `Is port ... in use?`,
        // Deno: `Address already in use`.
        expect(String((cause as Error)?.message)).toMatch(/in use/i);
      } finally {
        server.close();
      }
    });

    it("shutdown() waits for in-flight requests, then runs ipc.onClose", async () => {
      runner = create({
        name: "listen-shutdown",
        data: { entry: appShutdownEntry },
        listen: { port: 0, hostname: "127.0.0.1" },
      });
      const messages: string[] = [];
      runner.onMessage((message: any) => {
        if (typeof message?.type === "string" && message.type !== "pong") {
          messages.push(message.type);
        }
      });
      await runner.waitForReady();
      const started = new Promise<void>((resolve) => {
        runner!.onMessage((message: any) => message?.type === "slow-started" && resolve());
      });
      const slow = fetch(`http://127.0.0.1:${runner.address!.port}/slow`);
      await started;

      await runner.shutdown!();
      expect(runner.closed).toBe(true);
      expect(await (await slow).text()).toBe("slow");
      expect(messages).toEqual(["slow-started", "slow-responded", "ipc-closed"]);
    });

    it("RunnerManager.shutdown() shuts the active runner down", async () => {
      runner = create({ name: "manager-shutdown", data: { entry: appShutdownEntry } });
      const manager = new RunnerManager(runner);
      const closed = new Promise<void>((resolve) => {
        runner!.onMessage((message: any) => message?.type === "ipc-closed" && resolve());
      });
      await manager.waitForReady();
      await manager.shutdown();
      await closed;
      expect(manager.closed).toBe(true);
      expect(runner.closed).toBe(true);
    });
  });
}

describe("listen on runners without a worker server", () => {
  it("SelfEnvRunner closes with an error", async () => {
    const runner = new SelfEnvRunner({
      name: "self-listen",
      data: { entry: appEntry },
      listen: { port: 0 },
    } as any);
    await expect(runner.waitForReady()).rejects.toMatchObject({
      cause: { message: "Cannot use listen: the self runner does not support it" },
    });
  });

  it("MiniflareEnvRunner closes with an error", async () => {
    const runner = new MiniflareEnvRunner({
      miniflare,
      name: "miniflare-listen",
      data: { entry: appEntry },
      listen: { port: 0 },
    } as any);
    await expect(runner.waitForReady()).rejects.toMatchObject({
      cause: { message: "Cannot use listen: the miniflare runner does not support it" },
    });
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
