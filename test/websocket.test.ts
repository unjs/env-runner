import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { serve } from "srvx";
import type { Server } from "srvx";
import type { EnvRunner } from "../src/index.ts";
import { RunnerManager } from "../src/index.ts";
import { resolveWSProxyTarget } from "../src/common/ws-proxy.ts";

import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";

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

const _dir = dirname(fileURLToPath(import.meta.url));
const appWebsocketEntry = resolve(_dir, "./fixtures/app-websocket.mjs");
const appWebsocketRejectEntry = resolve(_dir, "./fixtures/app-websocket-reject.mjs");

const websocketRunners = [
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

for (const { name, create, skip } of websocketRunners) {
  describe.skipIf(skip ?? false)(`${name} websocket`, () => {
    let runner: EnvRunner | undefined;

    afterEach(async () => {
      await runner?.close();
      runner = undefined;
    });

    it("handles WebSocket via crossws hooks", async () => {
      let address: any;
      runner = create({
        name: "test-ws",
        data: { entry: appWebsocketEntry },
        hooks: {
          onReady: (_: any, addr: any) => {
            address = addr;
          },
        },
      });
      await runner!.waitForReady();
      expect(address).toBeDefined();

      const host = address.host || "127.0.0.1";
      const ws = new WebSocket(`ws://${host}:${address.port}/`);

      const messages: string[] = [];
      const closed = new Promise<void>((resolve) => {
        ws.addEventListener("message", (event) => {
          messages.push(String(event.data));
          if (messages.length === 1) {
            // Got welcome, send echo
            ws.send("hello");
          }
          if (messages.length === 2) {
            ws.close();
          }
        });
        ws.addEventListener("close", () => resolve());
      });

      await closed;
      expect(messages).toEqual(["welcome", "echo:hello"]);
    });
  });
}

describe("SelfEnvRunner websocket", () => {
  let runner: EnvRunner | undefined;
  let server: import("node:http").Server | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("handles WebSocket via crossws hooks", async () => {
    runner = new SelfEnvRunner({
      name: "test-ws-self",
      data: { entry: appWebsocketEntry },
    });
    await runner.waitForReady();

    // Create a minimal HTTP server to forward upgrade events to the self runner
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      runner!.upgrade!({ node: { req, socket: socket as any, head } });
    });
    const address = await new Promise<{ port: number }>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address() as import("node:net").AddressInfo;
        resolve({ port: addr.port });
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/`);

    const messages: string[] = [];
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event) => {
        messages.push(String(event.data));
        if (messages.length === 1) {
          ws.send("hello");
        }
        if (messages.length === 2) {
          ws.close();
        }
      });
      ws.addEventListener("close", () => resolve());
    });

    await closed;
    expect(messages).toEqual(["welcome", "echo:hello"]);
  });
});

describe("wsSrvxPlugin", () => {
  let manager: RunnerManager | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await manager?.close();
    manager = undefined;
  });

  // The `RunnerManager.wsSrvxPlugin()` attaches WebSocket proxying to a public
  // srvx server: on Node this is the raw-socket passthrough, exercised here
  // end-to-end through a real front server (the host process runs on Node).
  it("proxies upgrades to the worker through a srvx server", async () => {
    manager = new RunnerManager(
      new NodeWorkerEnvRunner({ name: "test-ws-proxy", data: { entry: appWebsocketEntry } }),
    );
    await manager.waitForReady();

    server = serve({
      port: 0,
      hostname: "127.0.0.1",
      gracefulShutdown: false,
      fetch: (request) => manager!.fetch(request),
      plugins: [await manager.wsSrvxPlugin()],
    });
    await server.ready();

    const ws = new WebSocket(new URL("/", server.url).href.replace(/^http/, "ws"));
    const messages: string[] = [];
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event) => {
        messages.push(String(event.data));
        if (messages.length === 1) {
          ws.send("hello");
        }
        if (messages.length === 2) {
          ws.close();
        }
      });
      ws.addEventListener("close", () => resolve());
    });

    await closed;
    expect(messages).toEqual(["welcome", "echo:hello"]);
  });
});

// The Bun/Deno bridge builds a `ws://` target from the worker address by hand;
// that branch never runs when the host process is Node (as in CI), so cover the
// URL construction directly. Guards against the host/port/socket assumptions the
// end-to-end passthrough test can't reach.
describe("resolveWSProxyTarget", () => {
  it("builds a ws:// URL preserving path and query", () => {
    expect(resolveWSProxyTarget({ host: "127.0.0.1", port: 1234 }, "http://front/foo?x=1")).toBe(
      "ws://127.0.0.1:1234/foo?x=1",
    );
  });

  it("uses the worker's reported host instead of assuming loopback", () => {
    expect(resolveWSProxyTarget({ host: "192.168.1.5", port: 80 }, "http://front/ws")).toBe(
      "ws://192.168.1.5:80/ws",
    );
  });

  it("falls back to 127.0.0.1 only when no host is reported", () => {
    expect(resolveWSProxyTarget({ port: 3000 }, "http://front/")).toBe("ws://127.0.0.1:3000/");
  });

  it("brackets an IPv6 host in the URL authority", () => {
    expect(resolveWSProxyTarget({ host: "::1", port: 8080 }, "http://front/chat")).toBe(
      "ws://[::1]:8080/chat",
    );
  });

  it("uses wss:// when the worker serves over TLS", () => {
    expect(
      resolveWSProxyTarget({ host: "example.com", port: 443, tls: true }, "http://front/ws"),
    ).toBe("wss://example.com:443/ws");
  });

  it("uses wss+unix:// for a TLS Unix-socket worker on Bun", () => {
    expect(
      resolveWSProxyTarget({ socketPath: "/tmp/worker.sock", tls: true }, "http://front/ws", {
        unixScheme: true,
      }),
    ).toBe("wss+unix:///tmp/worker.sock:/ws");
  });

  it("emits a ws+unix:// target for a Unix-socket worker on Bun", () => {
    expect(
      resolveWSProxyTarget({ socketPath: "/tmp/worker.sock" }, "http://front/chat?x=1", {
        unixScheme: true,
      }),
    ).toBe("ws+unix:///tmp/worker.sock:/chat?x=1");
  });

  it("rejects a Unix-socket worker when the runtime lacks ws+unix (Deno)", () => {
    expect(() => resolveWSProxyTarget({ socketPath: "/tmp/worker.sock" }, "http://front/")).toThrow(
      /Unix socket/,
    );
  });

  it("throws when the worker is not ready", () => {
    expect(() => resolveWSProxyTarget(undefined, "http://front/")).toThrow(/not ready/);
  });
});

describe("upgrade rejection", () => {
  let runner: EnvRunner | undefined;
  let server: import("node:http").Server | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  // A runner whose entry refuses the upgrade (the worker forwards a non-101
  // response, making `proxyUpgrade` reject; the self runner's entry hook throws
  // directly) must handle the rejection internally — `runner.upgrade()` is
  // called fire-and-forget, so an unhandled rejection would crash the process.
  const rejectRunners = [
    { name: "NodeWorkerEnvRunner", create: (opts: any) => new NodeWorkerEnvRunner(opts) },
    { name: "SelfEnvRunner", create: (opts: any) => new SelfEnvRunner(opts) },
  ];

  for (const { name, create } of rejectRunners) {
    it(`does not crash when the entry refuses the upgrade (${name})`, async () => {
      runner = create({
        name: "test-ws-reject",
        data: { entry: appWebsocketRejectEntry },
      });
      await runner.waitForReady();

      // Front HTTP server forwarding upgrade events through the runner (proxy).
      server = createServer();
      server.on("upgrade", (req, socket, head) => {
        runner!.upgrade!({ node: { req, socket: socket as any, head } });
      });
      const address = await new Promise<{ port: number }>((resolve) => {
        server!.listen(0, "127.0.0.1", () => {
          const addr = server!.address() as import("node:net").AddressInfo;
          resolve({ port: addr.port });
        });
      });

      // The rejected upgrade should close the socket without opening ...
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("upgrade timed out")), 10_000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error("upgrade should have been rejected"));
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // ... and the runner must still be alive (no crash from unhandled rejection).
      const res = await runner.fetch("http://localhost/");
      expect(await res.text()).toBe("ok");
    });
  }
});
