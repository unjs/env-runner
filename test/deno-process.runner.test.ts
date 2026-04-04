import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { DenoProcessEnvRunner } from "../src/runners/deno-process/runner.ts";

/** Minimal child-process stub with stream + event behavior for unit tests. */
class FakeChildProcess extends EventEmitter {
  pid = 123;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit("exit", 0);
    return true;
  });
}

const _dir = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(_dir, "../src/runners/deno-process/worker.ts");
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("DenoProcessEnvRunner", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("spawns deno and reaches ready state from stdout IPC", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as any);

    const runner = new DenoProcessEnvRunner({
      name: "deno-mock",
      workerEntry,
      data: { entry: appEntry },
    });

    child.stdout.write("not-json\n");
    child.stdout.write('{"address":{"host":"127.0.0.1","port":32123}}\n');
    await runner.waitForReady(2000);
    expect(runner.ready).toBe(true);

    const writes: string[] = [];
    child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    runner.sendMessage({ type: "ping", data: "x" });
    expect(writes.join("")).toContain('"type":"ping"');

    await runner.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("closes immediately when worker entry does not exist", async () => {
    const runner = new DenoProcessEnvRunner({
      name: "deno-missing",
      workerEntry: resolve(_dir, "./fixtures/does-not-exist.mjs"),
      data: { entry: appEntry },
    });

    expect(runner.closed).toBe(true);
  });
});
