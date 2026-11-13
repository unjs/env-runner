import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseEnvRunner } from "../src/index.ts";

/** A runner whose worker messages the test posts itself. */
class ManualRunner extends BaseEnvRunner {
  constructor() {
    super({ name: "manual", workerEntry: "" });
  }
  sendMessage() {}
  post(message: unknown) {
    this._handleMessage(message);
  }
  waitForAddress(timeout?: number) {
    return this._waitForAddress(timeout);
  }
  protected _hasRuntime() {
    return true;
  }
  protected async _closeRuntime() {}
  protected _runtimeType() {
    return "manual";
  }
}

const settled = (promise: Promise<unknown>) => {
  const state = { done: false };
  promise.then(() => (state.done = true));
  return state;
};

describe("BaseEnvRunner address wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes as soon as the worker reports its address", async () => {
    vi.useFakeTimers();
    const runner = new ManualRunner();
    const wait = settled(runner.waitForAddress());
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.done).toBe(false);

    runner.post({ address: { host: "127.0.0.1", port: 1 } });
    // No timer is due: the address message itself ends the wait.
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await runner.close();
  });

  it("ignores other messages and resumes when the runner closes", async () => {
    vi.useFakeTimers();
    const runner = new ManualRunner();
    const wait = settled(runner.waitForAddress());
    runner.post({ event: "log" });
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.done).toBe(false);

    await runner.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after the timeout, and fetch then returns 503", async () => {
    vi.useFakeTimers();
    const runner = new ManualRunner();
    const response = runner.fetch("http://localhost/");
    await vi.advanceTimersByTimeAsync(3099);
    const wait = settled(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect((await response).status).toBe(503);
    await runner.close();
  });
});
