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

const { BaseEnvRunner } = await import("../src/common/base-runner.ts");

class TestRunner extends BaseEnvRunner {
  constructor(address: WorkerAddress) {
    super({ name: "tls-test", workerEntry: "unused" });
    this._address = address;
  }
  sendMessage() {}
  protected _hasRuntime() {
    return true;
  }
  protected async _closeRuntime() {}
  protected _runtimeType() {
    return "test";
  }
}

const upgradeCtx = () => ({
  node: { req: {} as any, socket: {} as any, head: Buffer.alloc(0) },
});

describe("BaseEnvRunner TLS passthrough", () => {
  beforeEach(() => {
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

  it("fetches a TLS worker via an https:// URL and skips cert verification", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).fetch("/x");
    const [target, , , opts] = proxyFetch.mock.calls[0]!;
    expect(target).toBe("https://127.0.0.1:443");
    expect(opts).toEqual({ ssl: { rejectUnauthorized: false } });
  });

  it("brackets an IPv6 TLS host", async () => {
    await new TestRunner({ host: "::1", port: 8443, tls: true }).fetch("/x");
    expect(proxyFetch.mock.calls[0]![0]).toBe("https://[::1]:8443");
  });

  it("upgrades a TLS worker via a wss:// URL with secure: false", async () => {
    await new TestRunner({ host: "127.0.0.1", port: 443, tls: true }).upgrade(upgradeCtx());
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
});
