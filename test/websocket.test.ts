import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { EnvRunner } from "../src/index.ts";
import { hasBun, hasDeno } from "./utils.ts";

import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import { BunProcessEnvRunner } from "../src/runners/bun-process/runner.ts";
import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";
import { SelfEnvRunner } from "../src/runners/self/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appWebsocketEntry = resolve(_dir, "./fixtures/app-websocket.mjs");

const websocketRunners = [
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
