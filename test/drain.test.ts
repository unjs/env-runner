import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { serve } from "srvx";
import type { Server } from "srvx";
import type { EnvRunner } from "../src/index.ts";
import { EnvServer, RunnerManager } from "../src/index.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const streamEntry = resolve(_dir, "./fixtures/app-stream.mjs");

function createRunner(name: string) {
  return new NodeWorkerEnvRunner({ name, data: { entry: streamEntry } });
}

async function waitFor(condition: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A runner logging its calls. `shutdown()` closes it after `shutdownDelay` ms
 * (never settles when `undefined`), `stream` responses never end.
 */
function createFakeRunner(
  opts: { shutdownDelay?: number; stream?: boolean; reloadModule?: () => Promise<void> } = {},
) {
  const calls: string[] = [];
  const runner = {
    ready: true,
    closed: false,
    calls,
    onMessage() {},
    offMessage() {},
    sendMessage() {},
    fetch: async () => {
      calls.push("fetch");
      return new Response(opts.stream ? new ReadableStream() : "fake");
    },
    reloadModule: async () => {
      calls.push("reloadModule");
      await opts.reloadModule?.();
    },
    invalidateModule: async () => {},
    shutdown: () => {
      calls.push("shutdown");
      return new Promise<void>((resolve) => {
        if (opts.shutdownDelay !== undefined) {
          setTimeout(() => runner.close().then(resolve), opts.shutdownDelay);
        }
      });
    },
    close: async () => {
      calls.push("close");
      runner.closed = true;
    },
  };
  return runner as unknown as EnvRunner & { calls: string[] };
}

/** Fetch a streamed response and read its first chunk. */
async function startStream(manager: RunnerManager, delay: number) {
  const res = await manager.fetch(`http://localhost/?delay=${delay}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const rest = (async () => {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value);
    }
  })();
  // Cut streams reject before the test awaits `rest`.
  rest.catch(() => {});
  return { first, rest, reader };
}

describe("RunnerManager drained reload", () => {
  let manager: RunnerManager | undefined;
  let server: Server | undefined;
  let runners: EnvRunner[] = [];

  afterEach(async () => {
    await server?.close(true);
    server = undefined;
    await manager?.close();
    manager = undefined;
    for (const r of runners) {
      if (!r.closed) await r.close();
    }
    runners = [];
  });

  it("keeps a streamed response of the previous runner alive", async () => {
    const runner1 = createRunner("drain-stream-1");
    const runner2 = createRunner("drain-stream-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 500);
    const id1 = stream.first.split(":")[0];

    await manager.reload(runner2, { drain: true });
    // New requests go to the new runner right away.
    const id2 = await (await manager.fetch("http://localhost/")).text();
    expect(id2).not.toBe(id1);
    expect(runner1.closed).toBe(false);

    expect(await stream.rest).toBe(":end");
    await waitFor(() => runner1.closed);
    expect(runner2.closed).toBe(false);
  });

  it("closes the previous runner immediately without drain", async () => {
    const runner1 = createRunner("drain-off-1");
    const runner2 = createRunner("drain-off-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 500);
    await manager.reload(runner2);
    expect(runner1.closed).toBe(true);
    await expect(stream.rest).rejects.toThrow();
  });

  it("retires an idle previous runner right away", async () => {
    const runner1 = createRunner("drain-idle-1");
    const runner2 = createRunner("drain-idle-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();
    // A fully read response no longer counts.
    await (await manager.fetch("http://localhost/")).text();

    await manager.reload(runner2, { drain: true });
    await waitFor(() => runner1.closed);
  });

  it("settles a canceled response body", async () => {
    const runner1 = createRunner("drain-cancel-1");
    const runner2 = createRunner("drain-cancel-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 10_000);
    await manager.reload(runner2, { drain: true });
    expect(runner1.closed).toBe(false);
    await stream.reader.cancel();
    await waitFor(() => runner1.closed);
  });

  it("retires the previous runner after the drain timeout", async () => {
    const runner1 = createRunner("drain-timeout-1");
    const runner2 = createRunner("drain-timeout-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 10_000);
    const start = Date.now();
    await manager.reload(runner2, { drain: { timeout: 300 } });
    expect(runner1.closed).toBe(false);
    await waitFor(() => runner1.closed);
    // Closed at the timeout, without a graceful shutdown waiting for the stream.
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    expect(Date.now() - start).toBeLessThan(1500);
    await expect(stream.rest).rejects.toThrow();
  });

  it("closes draining runners with the manager", async () => {
    const runner1 = createRunner("drain-close-1");
    const runner2 = createRunner("drain-close-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 10_000);
    await manager.reload(runner2, { drain: true });
    await manager.close();
    expect(runner1.closed).toBe(true);
    expect(runner2.closed).toBe(true);
    await expect(stream.rest).rejects.toThrow();
  });

  it("stops draining a previous runner that closes itself", async () => {
    const runner1 = createRunner("drain-crash-1");
    const runner2 = createRunner("drain-crash-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();

    const stream = await startStream(manager, 10_000);
    await manager.reload(runner2, { drain: true });
    await runner1.close();
    await expect(stream.rest).rejects.toThrow();
    // Not retired twice, and the active runner is untouched.
    await manager.close();
    expect(runner2.closed).toBe(true);
  });

  it("closes a drained runner that is still shutting down with the manager", async () => {
    const runner1 = createFakeRunner();
    manager = new RunnerManager(runner1);
    await manager.reload(createFakeRunner(), { drain: true });
    expect(runner1.calls).toEqual(["shutdown"]);
    await manager.close();
    expect(runner1.calls).toEqual(["shutdown", "close"]);
  });

  it("shuts a drained runner down only once", async () => {
    const runner1 = createFakeRunner({ shutdownDelay: 100 });
    manager = new RunnerManager(runner1);
    await manager.reload(createFakeRunner({ shutdownDelay: 0 }), { drain: true });
    await manager.shutdown();
    expect(runner1.calls).toEqual(["shutdown", "close"]);
  });

  it("doesn't retire a draining runner that closed itself", async () => {
    const runner1 = createFakeRunner({ stream: true });
    manager = new RunnerManager(runner1);
    await manager.fetch("http://localhost/");
    await manager.reload(createFakeRunner(), { drain: true });
    await runner1.close();
    await manager.close();
    expect(runner1.calls).toEqual(["fetch", "close"]);
  });

  it("closes the previous runner after 60s by default", async () => {
    vi.useFakeTimers();
    try {
      const runner1 = createFakeRunner({ stream: true });
      manager = new RunnerManager(runner1);
      // The body is never read.
      await manager.fetch("http://localhost/");
      await manager.reload(createFakeRunner(), { drain: true });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(runner1.calls).toEqual(["fetch"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runner1.calls).toEqual(["fetch", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains without a limit with `timeout: Infinity`", async () => {
    vi.useFakeTimers();
    try {
      const runner1 = createFakeRunner({ stream: true });
      manager = new RunnerManager(runner1);
      await manager.fetch("http://localhost/");
      await manager.reload(createFakeRunner(), { drain: { timeout: Infinity } });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(runner1.calls).toEqual(["fetch"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a request from the moment it picks the runner", async () => {
    const runner1 = createFakeRunner({ shutdownDelay: 0 });
    manager = new RunnerManager(runner1);
    // `reload()` runs before the request reaches `runner1.fetch()`.
    const res = manager.fetch("http://localhost/");
    await manager.reload(createFakeRunner(), { drain: true });
    expect(await (await res).text()).toBe("fake");
    await waitFor(() => runner1.closed);
    expect(runner1.calls).toEqual(["fetch", "shutdown", "close"]);
  });

  it("keeps the new runner's invalidation when a draining runner's module reload settles", async () => {
    let finishReload!: () => void;
    const runner1 = createFakeRunner({
      reloadModule: () => new Promise<void>((resolve) => (finishReload = resolve)),
    });
    const runner2 = createFakeRunner();
    manager = new RunnerManager(runner1);
    await manager.invalidateModule("#config");
    // Reloads `runner1` first (pending until `finishReload()`).
    const res1 = manager.fetch("http://localhost/");
    await manager.reload(runner2, { drain: true });
    await manager.invalidateModule("#config");
    const res2 = manager.fetch("http://localhost/");
    finishReload();
    await (await res1).text();
    await (await res2).text();
    expect(runner1.calls).toEqual(["reloadModule", "fetch", "shutdown"]);
    expect(runner2.calls).toEqual(["reloadModule", "fetch"]);
    // The invalidation is satisfied: no further reload.
    await (await manager.fetch("http://localhost/")).text();
    expect(runner2.calls).toEqual(["reloadModule", "fetch", "fetch"]);
  });

  it("keeps a WebSocket of the previous runner open", async () => {
    const runner1 = createRunner("drain-ws-1");
    const runner2 = createRunner("drain-ws-2");
    runners.push(runner1, runner2);
    manager = new RunnerManager(runner1);
    await manager.waitForReady();
    server = serve({
      port: 0,
      hostname: "127.0.0.1",
      gracefulShutdown: false,
      fetch: (request) => manager!.fetch(request),
      plugins: [await manager.wsSrvxPlugin()],
    });
    await server.ready();

    const ws = new WebSocket(server.url!.replace(/^http/, "ws"));
    const messages: string[] = [];
    const nextMessage = () =>
      new Promise<string>((resolve) => {
        ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    ws.send("before");
    messages.push(await nextMessage());

    await manager.reload(runner2, { drain: true });
    const id2 = await (await manager.fetch("http://localhost/")).text();
    ws.send("after");
    messages.push(await nextMessage());
    const [id1] = messages[0]!.split(":");
    expect(messages).toEqual([`${id1}:before`, `${id1}:after`]);
    expect(id2).not.toBe(id1);
    expect(runner1.closed).toBe(false);

    ws.close();
    await waitFor(() => runner1.closed);
  });

  it("EnvServer `drain` option applies to reloads", async () => {
    const envServer = new EnvServer({ entry: streamEntry, drain: true });
    manager = envServer;
    await envServer.start();
    const runner1 = envServer.runner!;

    const stream = await startStream(envServer, 500);
    await envServer.reload();
    expect(envServer.runner).not.toBe(runner1);
    expect(runner1.closed).toBe(false);
    expect(await stream.rest).toBe(":end");
    await waitFor(() => runner1.closed);
  });
});
