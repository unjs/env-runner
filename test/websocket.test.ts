import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { serve } from "srvx";
import type { Server } from "srvx";
import * as miniflare from "miniflare";
import type { EnvRunner } from "../src/index.ts";
import { RunnerManager } from "../src/index.ts";
import { resolveWSProxyTarget } from "../src/common/ws-proxy.ts";

import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";

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
const appWebsocketResolveEntry = resolve(_dir, "./fixtures/app-websocket-resolve.mjs");

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

  it("brackets a bare IPv6 host in the URL authority", () => {
    expect(resolveWSProxyTarget({ host: "::1", port: 8080 }, "http://front/chat")).toBe(
      "ws://[::1]:8080/chat",
    );
  });

  it("does not double-bracket an already-bracketed IPv6 host", () => {
    // `parseServerAddress()` reports `URL.hostname`, which is already bracketed.
    expect(resolveWSProxyTarget({ host: "[::1]", port: 8080 }, "http://front/chat")).toBe(
      "ws://[::1]:8080/chat",
    );
  });

  it("emits a ws+unix:// target for a Unix-socket worker (dialed uniformly by crossws)", () => {
    expect(resolveWSProxyTarget({ socketPath: "/tmp/worker.sock" }, "http://front/chat?x=1")).toBe(
      "ws+unix:///tmp/worker.sock:/chat?x=1",
    );
  });

  it("throws when the worker is not ready", () => {
    expect(() => resolveWSProxyTarget(undefined, "http://front/")).toThrow(/not ready/);
  });
});

// End-to-end coverage for the `createRunnerWSProxyPlugin` Bun/Deno bridge — the
// crossws terminate-and-redial path that the Node-hosted vitest process never
// reaches (on Node the plugin uses the raw-socket passthrough instead). Spawns a
// fixture under bun/deno that carries the plugin in front of a crossws echo
// worker, then connects a client from Node through it.
const bridgeHosts = [
  { name: "Bun", cmd: "bun", args: [] as string[], skip: !hasBun },
  {
    name: "Deno",
    cmd: "deno",
    args: ["run", "-A", "--node-modules-dir=auto", "--no-lock"],
    skip: !hasDeno,
  },
];
const bridgeFixture = resolve(_dir, "./fixtures/ws-bridge-server.mjs");
const bridgeMiniflareFixture = resolve(_dir, "./fixtures/ws-bridge-miniflare.mjs");

for (const { name, cmd, args, skip } of bridgeHosts) {
  describe.skipIf(skip)(`wsProxy bridge (${name} host)`, () => {
    let child: ChildProcess | undefined;

    afterEach(() => {
      child?.kill();
      child = undefined;
    });

    function startBridge(fixture = bridgeFixture) {
      const proc = spawn(cmd, [...args, fixture], { stdio: ["ignore", "pipe", "pipe"] });
      child = proc;
      return new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`bridge did not start:\n${out}`)), 20_000);
        proc.stdout!.on("data", (d) => {
          out += String(d);
          const match = out.match(/READY (\S+)/);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        proc.stderr!.on("data", (d) => (out += String(d)));
        proc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`bridge exited (${code}) before ready:\n${out}`));
        });
      });
    }

    async function echo(frontUrl: string) {
      const ws = new WebSocket(frontUrl.replace(/^http/, "ws"));
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
      return messages;
    }

    it("terminates the client with crossws and proxies to the worker", async () => {
      expect(await echo(await startBridge())).toEqual(["welcome", "echo:hello"]);
    }, 30_000);

    // The bridge dials the workerd direct socket the miniflare runner reports.
    it("proxies to a miniflare runner", async () => {
      expect(await echo(await startBridge(bridgeMiniflareFixture))).toEqual([
        "welcome",
        "echo:hello",
      ]);
    }, 30_000);

    // A drained `reload()` retires the previous runner only once the bridged
    // WebSocket it serves closes.
    it("drains a bridged WebSocket on a drained reload", async () => {
      const frontUrl = await startBridge();
      const get = async (path: string) => (await fetch(frontUrl + path)).text();

      const ws = new WebSocket(frontUrl.replace(/^http/, "ws"));
      await new Promise((resolve) => ws.addEventListener("message", resolve, { once: true }));
      expect(await get("reload")).toBe("reloaded");
      expect(await get("retired")).toBe("false");

      ws.close();
      const start = Date.now();
      while ((await get("retired")) !== "true") {
        if (Date.now() - start > 5000) throw new Error("Previous runner not retired");
        await new Promise((r) => setTimeout(r, 50));
      }
    }, 30_000);

    // Dialed once the runner is ready (the async target): tracked against it.
    it("drains a WebSocket bridged while the runner was starting", async () => {
      const frontUrl = await startBridge();
      const get = async (path: string) => (await fetch(frontUrl + path)).text();

      expect(await get("reload-starting")).toBe("reloaded");
      const ws = new WebSocket(frontUrl.replace(/^http/, "ws"));
      const welcome = new Promise((resolve) =>
        ws.addEventListener("message", resolve, { once: true }),
      );
      await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
      expect(await get("start")).toBe("started");
      await welcome;

      expect(await get("reload")).toBe("reloaded");
      expect(await get("retired?runner=1")).toBe("false");
      ws.close();
      const start = Date.now();
      while ((await get("retired?runner=1")) !== "true") {
        if (Date.now() - start > 5000) throw new Error("Previous runner not retired");
        await new Promise((r) => setTimeout(r, 50));
      }
    }, 30_000);
  });
}

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

describe("MiniflareEnvRunner websocket", () => {
  let runner: EnvRunner | undefined;
  let server: import("node:http").Server | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  // Front server forwarding upgrades to a miniflare runner for `entry`.
  async function start(
    entry: string,
    opts?: Partial<ConstructorParameters<typeof MiniflareEnvRunner>[0]>,
  ) {
    runner = new MiniflareEnvRunner({
      miniflare,
      name: "test-ws-miniflare",
      data: { entry },
      ...opts,
    });
    await runner.waitForReady();

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
    return address.port;
  }

  async function echo(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no echo (${messages})`)), 10_000);
      ws.addEventListener("message", (event) => {
        messages.push(String(event.data));
        if (messages.length === 1) {
          ws.send("hello");
        }
        if (messages.length === 2) {
          ws.close();
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return messages;
  }

  it("handles WebSocket via crossws hooks", async () => {
    expect(await echo(await start(appWebsocketEntry))).toEqual(["welcome", "echo:hello"]);
  });

  it("handles WebSocket via a crossws `resolve` hook", async () => {
    expect(await echo(await start(appWebsocketResolveEntry))).toEqual(["welcome", "echo:hello"]);
  });

  // No `node_modules` next to the entry: crossws resolves from env-runner.
  it("handles WebSocket for an entry outside the project", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "env-runner-ws-"));
    const entry = join(tmpDir, "entry.mjs");
    writeFileSync(entry, readFileSync(appWebsocketEntry, "utf8"));
    expect(await echo(await start(entry))).toEqual(["welcome", "echo:hello"]);
  });

  it("handles WebSocket added by a reload", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "env-runner-ws-"));
    const entry = join(tmpDir, "entry.mjs");
    writeFileSync(entry, `export default { fetch: () => new Response("ok") };`);
    const port = await start(entry);
    writeFileSync(entry, readFileSync(appWebsocketResolveEntry, "utf8"));
    await runner!.reloadModule!();
    expect(await echo(port)).toEqual(["welcome", "echo:hello"]);
  });

  // Entry whose Durable Object greets with the instance it was reached as
  // (`WS_OBJECT`, auto-bound); `websocket` (code) is its crossws options,
  // whose own hooks answer `fallback`.
  function writeDurableEntry(websocket = `{ open(peer) { peer.send("fallback"); } }`) {
    tmpDir = mkdtempSync(join(tmpdir(), "env-runner-ws-"));
    const entry = join(tmpDir, "entry.mjs");
    writeFileSync(
      entry,
      /* js */ `import { DurableObject } from "cloudflare:workers";
export class WsObject extends DurableObject {
  fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const name = ["server", "crossws", "entry"].find((name) =>
      this.ctx.id.equals(this.env.WS_OBJECT.idFromName(name)),
    );
    server.send("do:" + name);
    return new Response(null, { status: 101, webSocket: client });
  }
}
export default {
  fetch: () => new Response("ok"),
  websocket: ${websocket},
};`,
    );
    return entry;
  }

  async function firstMessage(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message")), 10_000);
        ws.addEventListener("message", (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        });
      });
    } finally {
      ws.close();
    }
  }

  it("applies the `crossws` option to the entry's `websocket`", async () => {
    const port = await start(writeDurableEntry(), {
      crossws: { bindingName: "WS_OBJECT", instanceName: "server" },
    });
    expect(await firstMessage(port)).toBe("do:server");
  });

  it("prefers the entry's `websocket.options.cloudflare` over `crossws`", async () => {
    const entry = writeDurableEntry(
      `{ open() {}, options: { cloudflare: { instanceName: "entry" } } }`,
    );
    const port = await start(entry, {
      crossws: { bindingName: "WS_OBJECT", instanceName: "server" },
    });
    expect(await firstMessage(port)).toBe("do:entry");
  });

  it("ignores `undefined` values of the entry's `websocket.options.cloudflare`", async () => {
    const entry = writeDurableEntry(
      `{ open() {}, options: { cloudflare: { instanceName: undefined } } }`,
    );
    const port = await start(entry, {
      crossws: { bindingName: "WS_OBJECT", instanceName: "server" },
    });
    expect(await firstMessage(port)).toBe("do:server");
  });

  // Hooks on a prototype stay visible to crossws (only `options` is shadowed).
  it("keeps `websocket` hooks of a class instance with `crossws`", async () => {
    const entry = writeDurableEntry(`new (class { open(peer) { peer.send("fallback"); } })()`);
    const port = await start(entry, { crossws: { bindingName: "MISSING" } });
    expect(await firstMessage(port)).toBe("fallback");
  });

  it("keeps crossws defaults without the `crossws` option", async () => {
    expect(await firstMessage(await start(writeDurableEntry()))).toBe("fallback");
  });

  // An instance is only shared while a runner still holds it.
  it("does not share persistent instances across `crossws` options", async () => {
    const entry = writeDurableEntry();
    const opts = (instanceName: string) => ({
      persistent: true,
      crossws: { bindingName: "WS_OBJECT", instanceName },
    });
    await start(entry, opts("server"));
    const first = { runner: runner!, server: server! };
    try {
      expect(await firstMessage(await start(entry, opts("entry")))).toBe("do:entry");
    } finally {
      await first.runner.close();
      first.server.close();
      await MiniflareEnvRunner.disposeAll();
    }
  });
});
