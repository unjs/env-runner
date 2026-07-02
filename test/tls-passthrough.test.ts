import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkerAddress } from "../src/types.ts";

// Capture the httpxy calls so we can assert how a TLS worker address is
// threaded into the Node passthrough (httpxy only negotiates TLS for a
// URL-string target with an `https:`/`wss:` scheme, not the object form).
const { proxyFetch, proxyUpgrade } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  proxyUpgrade: vi.fn(),
}));
vi.mock("httpxy", () => ({ proxyFetch, proxyUpgrade }));

import { BaseEnvRunner } from "../src/common/base-runner.ts";

class TestRunner extends BaseEnvRunner {
  #hasRuntime: boolean;
  constructor(address: WorkerAddress, insecure = false, hasRuntime = true) {
    super({ name: "tls-test", workerEntry: "unused", insecure });
    this._address = address;
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
}

const upgradeCtx = () => ({
  node: { req: {} as any, socket: { destroy() {} } as any, head: Buffer.alloc(0) },
});

describe("BaseEnvRunner TLS passthrough", () => {
  beforeEach(() => {
    // Guard against the mock silently not applying (a source of CI flakiness):
    // if httpxy weren't mocked these would hit the network instead of asserting.
    expect(vi.isMockFunction(proxyFetch)).toBe(true);
    proxyFetch.mockReset().mockResolvedValue(new Response("ok"));
    proxyUpgrade.mockReset().mockResolvedValue(undefined);
  });

  it("fetches a cleartext worker with the plain address object", async () => {
    const address = { host: "127.0.0.1", port: 1234 };
    await new TestRunner(address).fetch("/x");
    const [target, , , opts] = proxyFetch.mock.calls[0]!;
    expect(target).toEqual(address);
    expect(opts).toBeUndefined();
  });

  it("fetches a TLS worker via an https:// URL and verifies the cert by default", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).fetch("/x");
    const [target, , , opts] = proxyFetch.mock.calls[0]!;
    expect(target).toBe("https://127.0.0.1:443");
    expect(opts).toBeUndefined();
  });

  it("skips cert verification only when `insecure` is opted in", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }, true).fetch("/x");
    const [target, , , opts] = proxyFetch.mock.calls[0]!;
    expect(target).toBe("https://127.0.0.1:443");
    expect(opts).toEqual({ ssl: { rejectUnauthorized: false } });
  });

  it("brackets a bare IPv6 TLS host", async () => {
    await new TestRunner({ host: "::1", port: 8443, tls: true }).fetch("/x");
    expect(proxyFetch.mock.calls[0]![0]).toBe("https://[::1]:8443");
  });

  it("does not double-bracket an already-bracketed IPv6 host", async () => {
    // `parseServerAddress()` reports the host from `URL.hostname`, which is
    // already bracketed for IPv6 literals.
    await new TestRunner({ host: "[::1]", port: 8443, tls: true }).fetch("/x");
    expect(proxyFetch.mock.calls[0]![0]).toBe("https://[::1]:8443");
  });

  it("upgrades a TLS worker via a wss:// URL, verifying the cert by default", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).upgrade(upgradeCtx());
    const [target, , , , opts] = proxyUpgrade.mock.calls[0]!;
    expect(target).toBe("wss://127.0.0.1:443");
    expect(opts).toBeUndefined();
  });

  it("upgrades a TLS worker with secure:false only when `insecure` is opted in", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }, true).upgrade(upgradeCtx());
    const [target, , , , opts] = proxyUpgrade.mock.calls[0]!;
    expect(target).toBe("wss://127.0.0.1:443");
    expect(opts).toEqual({ secure: false });
  });

  it("upgrades a cleartext worker with the plain address object", async () => {
    const address = { host: "127.0.0.1", port: 1234 };
    await new TestRunner(address).upgrade(upgradeCtx());
    const [target, , , , opts] = proxyUpgrade.mock.calls[0]!;
    expect(target).toEqual(address);
    expect(opts).toBeUndefined();
  });

  it("destroys the raw socket when the worker never becomes ready", async () => {
    // `hasRuntime: false` keeps the runner permanently not-ready.
    const runner = new TestRunner({ host: "127.0.0.1", port: 1234 }, false, false);
    // Force the not-ready give-up path without waiting out waitForReady.
    vi.spyOn(runner, "waitForReady").mockRejectedValue(new Error("nope"));
    const ctx = upgradeCtx();
    const destroy = vi.spyOn(ctx.node.socket, "destroy");
    await runner.upgrade(ctx);
    expect(destroy).toHaveBeenCalled();
    expect(proxyUpgrade).not.toHaveBeenCalled();
  });
});
