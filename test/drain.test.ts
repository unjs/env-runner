import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { FastResponse, serve } from "srvx";
import type { Server } from "srvx";
import type { EnvRunner } from "../src/index.ts";
import { EnvServer, RunnerManager } from "../src/index.ts";
import { createRunnerWSProxyPlugin } from "../src/common/ws-proxy.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";

// Unchanged, but records the `track` function the manager passes.
vi.mock("../src/common/ws-proxy.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/common/ws-proxy.ts")>();
  return { ...original, createRunnerWSProxyPlugin: vi.fn(original.createRunnerWSProxyPlugin) };
});

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
 * (never settles when `undefined`; throws with `shutdownThrows`), `stream`
 * responses never end, `respond` replaces the response.
 */
function createFakeRunner(
  opts: {
    shutdownDelay?: number;
    shutdownThrows?: boolean;
    stream?: boolean;
    respond?: () => Response;
    reloadModule?: () => Promise<void>;
  } = {},
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
      return opts.respond?.() ?? new Response(opts.stream ? new ReadableStream() : "fake");
    },
    reloadModule: async () => {
      calls.push("reloadModule");
      await opts.reloadModule?.();
    },
    invalidateModule: async () => {},
    shutdown: () => {
      calls.push("shutdown");
      if (opts.shutdownThrows) {
        throw new Error("shutdown failed");
      }
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
    expect(Date.now() - start).toBeLessThan(5000);
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

  it("keeps serving a draining runner that is attached again", async () => {
    let endStream!: () => void;
    const runner1 = createFakeRunner({
      respond: () =>
        new Response(
          new ReadableStream({ start: (controller) => (endStream = () => controller.close()) }),
        ),
    });
    const runner2 = createFakeRunner();
    manager = new RunnerManager(runner1);
    let closes = 0;
    manager.onClose(() => closes++);
    const res = await manager.fetch("http://localhost/");
    await manager.reload(runner2, { drain: true });
    // Swapping back closes `runner2` and stops `runner1` draining.
    await manager.reload(runner1);
    expect(runner2.closed).toBe(true);
    endStream();
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    expect(runner1.calls).toEqual(["fetch"]);
    expect(manager.ready).toBe(true);
    // Reported to `onClose()` once (its `close()` is wrapped once).
    await runner1.close();
    expect(closes).toBe(1);
  });

  it("keeps the active runner on a reload with itself", async () => {
    const runner1 = createFakeRunner();
    manager = new RunnerManager(runner1);
    await manager.reload(runner1, { drain: true });
    await manager.reload(runner1);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner1.calls).toEqual([]);
    expect(await (await manager.fetch("http://localhost/")).text()).toBe("fake");
  });

  it("uses the default timeout for `timeout: NaN`, and 0 for negative ones", async () => {
    vi.useFakeTimers();
    try {
      const runner1 = createFakeRunner({ stream: true });
      manager = new RunnerManager(runner1);
      await manager.fetch("http://localhost/");
      const runner2 = createFakeRunner({ stream: true });
      await manager.reload(runner2, { drain: { timeout: Number.NaN } });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(runner1.calls).toEqual(["fetch"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runner1.calls).toEqual(["fetch", "close"]);

      await manager.fetch("http://localhost/");
      await manager.reload(createFakeRunner(), { drain: { timeout: -1 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(runner2.calls).toEqual(["fetch", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a drained runner's `shutdown()` that throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      manager = new RunnerManager(createFakeRunner({ shutdownThrows: true }));
      await manager.reload(createFakeRunner(), { drain: true });
      await new Promise((r) => setTimeout(r, 20));
      expect(error).toHaveBeenCalledWith(
        "[env-runner] Failed to close the drained runner:",
        expect.objectContaining({ message: "shutdown failed" }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("keeps the headers srvx derives for a runner's `FastResponse`", async () => {
    manager = new RunnerManager(createFakeRunner({ respond: () => new FastResponse("hello") }));
    server = serve({
      port: 0,
      hostname: "127.0.0.1",
      gracefulShutdown: false,
      silent: true,
      fetch: (request) => manager!.fetch(request),
    });
    await server.ready();
    for (const method of ["GET", "HEAD"]) {
      const res = await fetch(server.url!, { method });
      expect(res.headers.get("content-length")).toBe("5");
      expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
      expect(await res.text()).toBe(method === "GET" ? "hello" : "");
    }
  });

  it("tracks `FastResponse` stream bodies", async () => {
    let endStream!: () => void;
    const bodies = [
      () => new ReadableStream({ start: (controller) => (endStream = () => controller.close()) }),
      ...[true, false].map((autoDestroy) => () => {
        // Without `autoDestroy`, it ends without closing.
        const stream = new Readable({ read() {}, autoDestroy });
        endStream = () => stream.push(null);
        return stream;
      }),
    ];
    for (const body of bodies) {
      const runner1 = createFakeRunner({
        shutdownDelay: 0,
        respond: () => new FastResponse(body() as BodyInit),
      });
      manager = new RunnerManager(runner1);
      const res = await manager.fetch("http://localhost/");
      await manager.reload(createFakeRunner(), { drain: true });
      expect(runner1.calls).toEqual(["fetch"]);
      endStream();
      await res.text();
      await waitFor(() => runner1.closed);
      await manager.close();
    }
  });

  describe("through a srvx server", () => {
    let received = 0;
    let runner1: EnvRunner;
    let runner2: EnvRunner;

    async function setup(name: string) {
      runner1 = createRunner(`${name}-1`);
      runner2 = createRunner(`${name}-2`);
      runners.push(runner1, runner2);
      manager = new RunnerManager(runner1);
      await manager.waitForReady();
      received = 0;
      server = serve({
        port: 0,
        hostname: "127.0.0.1",
        gracefulShutdown: false,
        fetch: (request) => {
          received++;
          return manager!.fetch(request);
        },
      });
      await server.ready();
    }

    it("settles a request whose client disconnects before the response", async () => {
      await setup("drain-abort");
      const error = vi.spyOn(console, "error");
      try {
        const controller = new AbortController();
        const pending = fetch(`${server!.url}?wait=10000`, { signal: controller.signal });
        pending.catch(() => {});
        await waitFor(() => received === 1);
        await manager!.reload(runner2, { drain: { timeout: Infinity } });
        expect(runner1.closed).toBe(false);
        controller.abort();
        // Without the worker request aborted, only its response would settle it.
        await waitFor(() => runner1.closed, 3000);
        // Not reported as a fetch handler error.
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });

    it("settles a streamed response whose client disconnects", async () => {
      await setup("drain-disconnect");
      const controller = new AbortController();
      const res = await fetch(`${server!.url}?delay=10000`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read();
      await manager!.reload(runner2, { drain: { timeout: Infinity } });
      expect(runner1.closed).toBe(false);
      controller.abort();
      await waitFor(() => runner1.closed, 3000);
    });

    it("settles proxied responses without a body", async () => {
      await setup("drain-no-body");
      for (const [query, method, status] of [
        ["status=204", "GET", 204],
        ["status=304", "GET", 304],
        ["cookies", "HEAD", 200],
        ["delay=10000", "HEAD", 200],
      ] as const) {
        const res = await fetch(`${server!.url}?${query}`, { method });
        expect(res.status).toBe(status);
        expect(await res.text()).toBe("");
      }
      const res = await fetch(`${server!.url}?cookies`);
      expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      await res.text();
      // A HEAD response whose (empty) body is never read.
      await manager!.fetch("http://localhost/?delay=10000", { method: "HEAD" });

      await manager!.reload(runner2, { drain: { timeout: Infinity } });
      await waitFor(() => runner1.closed, 3000);
    });
  });

  it("counts an upgrade waiting for its runner to become ready", async () => {
    let ready!: () => void;
    const runner1 = createFakeRunner({ shutdownDelay: 0 });
    runner1.upgrade = async () => {
      runner1.calls.push("upgrade");
      await new Promise<void>((resolve) => (ready = resolve));
    };
    manager = new RunnerManager(runner1);
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() {} });
    const upgrading = manager.upgrade({ node: { req: {}, socket, head: undefined } } as any);
    await manager.reload(createFakeRunner(), { drain: { timeout: Infinity } });
    ready();
    await upgrading;
    expect(runner1.calls).toEqual(["upgrade"]);
    socket.emit("close");
    await waitFor(() => runner1.closed);
  });

  it("refuses a bridged WebSocket dialed to a runner swapped out meanwhile", async () => {
    const runner1 = Object.assign(createFakeRunner({ shutdownDelay: 0 }), {
      address: { host: "127.0.0.1", port: 1 },
    });
    const runner2 = Object.assign(createFakeRunner({ shutdownDelay: 0 }), {
      address: { host: "127.0.0.1", port: 2 },
    });
    manager = new RunnerManager(runner1);
    vi.mocked(createRunnerWSProxyPlugin).mockClear();
    await manager.wsSrvxPlugin();
    const track = vi.mocked(createRunnerWSProxyPlugin).mock.calls[0]![1]!;

    await manager.reload(runner2, { drain: { timeout: Infinity } });
    // Dialed to `runner1` (retiring as idle): refused, crossws closes it with 1011.
    expect(() => track(runner1.address)).toThrow("The runner changed");
    const settle = track(runner2.address)!;
    await manager.reload(createFakeRunner(), { drain: { timeout: Infinity } });
    expect(runner2.calls).toEqual([]);
    settle();
    await waitFor(() => runner2.closed);
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
