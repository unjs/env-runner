import { describe, it, expect, vi } from "vitest";
import type { WorkerAddress } from "../src/types.ts";
import { BaseEnvRunner } from "../src/common/base-runner.ts";

// Note: these tests deliberately avoid `vi.mock("httpxy")`. Mocking a module
// that `base-runner` imports transitively is unreliable under coverage
// instrumentation + shared test workers (it silently fails to intercept, so the
// real httpxy runs and hits the network). Instead we assert the pure target /
// option decision (`_tlsTarget`, the `insecure` flag) and the socket-cleanup
// behavior directly, which is where all the logic under review lives.

class TestRunner extends BaseEnvRunner {
  #hasRuntime: boolean;
  constructor(address?: WorkerAddress, insecure = false, hasRuntime = true) {
    super({ name: "tls-test", workerEntry: "unused", insecure });
    if (address) this._address = address;
    this.#hasRuntime = hasRuntime;
  }
  sendMessage() {}
  protected _hasRuntime() {
    return this.#hasRuntime;
  }
  protected async _closeRuntime() {}
  protected _runtimeType() {
    return "test";
  }
  // Expose protected internals for assertions.
  tlsTarget(scheme: "https" | "wss") {
    return this._tlsTarget(scheme);
  }
  get insecureFlag() {
    return this._insecure;
  }
}

describe("BaseEnvRunner._tlsTarget", () => {
  it("returns undefined for a cleartext worker (proxy keeps the address object)", () => {
    expect(new TestRunner({ host: "127.0.0.1", port: 1234 }).tlsTarget("https")).toBeUndefined();
  });

  it("builds an https:// URL for a TLS worker", () => {
    expect(new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).tlsTarget("https")).toBe(
      "https://127.0.0.1:443",
    );
  });

  it("builds a wss:// URL for a TLS worker", () => {
    expect(new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).tlsTarget("wss")).toBe(
      "wss://127.0.0.1:443",
    );
  });

  it("brackets a bare IPv6 TLS host", () => {
    expect(new TestRunner({ host: "::1", port: 8443, tls: true }).tlsTarget("https")).toBe(
      "https://[::1]:8443",
    );
  });

  it("does not double-bracket an already-bracketed IPv6 host", () => {
    // `parseServerAddress()` reports the host from `URL.hostname`, which is
    // already bracketed for IPv6 literals.
    expect(new TestRunner({ host: "[::1]", port: 8443, tls: true }).tlsTarget("https")).toBe(
      "https://[::1]:8443",
    );
  });

  it("returns undefined for a TLS Unix-socket worker (falls back to the object form)", () => {
    expect(
      new TestRunner({ socketPath: "/tmp/w.sock", tls: true }).tlsTarget("wss"),
    ).toBeUndefined();
  });
});

describe("BaseEnvRunner insecure opt-in", () => {
  it("defaults to verifying the worker certificate", () => {
    expect(new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).insecureFlag).toBe(false);
  });

  it("stores the `insecure` opt-in", () => {
    expect(new TestRunner({ host: "127.0.0.1", port: 443, tls: true }, true).insecureFlag).toBe(
      true,
    );
  });
});

describe("BaseEnvRunner.upgrade give-up path", () => {
  it("destroys the raw socket when the worker never becomes ready", async () => {
    // `hasRuntime: false` keeps the runner permanently not-ready, so upgrade()
    // takes the give-up branch before ever reaching httpxy.
    const runner = new TestRunner({ host: "127.0.0.1", port: 1234 }, false, false);
    vi.spyOn(runner, "waitForReady").mockRejectedValue(new Error("nope"));
    const socket = { destroy: vi.fn() };
    await runner.upgrade({
      node: { req: {} as any, socket: socket as any, head: Buffer.alloc(0) },
    });
    expect(socket.destroy).toHaveBeenCalled();
  });
});
