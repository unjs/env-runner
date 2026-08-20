import { describe, expect, it, vi } from "vitest";
import { registerVercelQueueConsumer } from "../src/runners/vercel/queue-dev.ts";
import type { VercelQueueSdk } from "../src/runners/vercel/queue-dev.ts";

// The real `@vercel/queue` module namespace must stay assignable to the
// structural `VercelQueueSdk` type (typecheck-only guard).
const _sdkIsCompatible: typeof import("@vercel/queue") extends VercelQueueSdk ? true : never = true;
void _sdkIsCompatible;

// A stand-in for the `@vercel/queue` package the caller imports and passes in.
function createSdk(overrides: Partial<VercelQueueSdk> = {}) {
  const registrations: any[] = [];
  const clients: any[] = [];
  const sdk: VercelQueueSdk = {
    QueueClient: class {
      constructor() {
        clients.push(this);
      }
    },
    registerDevConsumer: (options) => {
      registrations.push(options);
      return () => registrations.splice(registrations.indexOf(options), 1);
    },
    ...overrides,
  };
  return { sdk, registrations, clients };
}

describe("registerVercelQueueConsumer", () => {
  it("registers through an SDK passed as a module specifier", async () => {
    const specifier = import.meta.resolve("./fixtures/queue-sdk-stub.mjs");
    const handler = vi.fn();

    await registerVercelQueueConsumer({ sdk: specifier, topic: "from-specifier", handler });

    const { registrations } = await import("./fixtures/queue-sdk-stub.mjs");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ topic: "from-specifier", handler });
  });

  it("registers through the passed SDK", async () => {
    const { sdk, registrations, clients } = createSdk();
    const handler = vi.fn();

    const unregister = await registerVercelQueueConsumer({ sdk, topic: "orders", handler });

    expect(clients).toHaveLength(1);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      topic: "orders",
      handler,
      client: clients[0],
      consumerGroup: "env-runner-vercel-dev",
    });

    unregister();
    expect(registrations).toHaveLength(0);
  });

  it("reuses one QueueClient per SDK instance", async () => {
    const { sdk, clients } = createSdk();
    await registerVercelQueueConsumer({ sdk, topic: "a", handler: vi.fn() });
    await registerVercelQueueConsumer({ sdk, topic: "b", handler: vi.fn() });
    expect(clients).toHaveLength(1);

    // A different SDK instance gets its own client.
    const other = createSdk();
    await registerVercelQueueConsumer({ sdk: other.sdk, topic: "c", handler: vi.fn() });
    expect(other.clients).toHaveLength(1);
  });

  it("forwards `consumerGroup` and `visibilityTimeoutSeconds`", async () => {
    const { sdk, registrations } = createSdk();
    await registerVercelQueueConsumer({
      sdk,
      topic: "orders",
      handler: vi.fn(),
      consumerGroup: "nitro",
      visibilityTimeoutSeconds: 42,
    });
    expect(registrations[0]).toMatchObject({
      consumerGroup: "nitro",
      visibilityTimeoutSeconds: 42,
    });
  });

  it("maps `retryAfterSeconds` to a constant-delay retry handler", async () => {
    const { sdk, registrations } = createSdk();
    await registerVercelQueueConsumer({
      sdk,
      topic: "orders",
      handler: vi.fn(),
      retryAfterSeconds: 5,
    });
    expect(registrations[0].retry(new Error("boom"), {} as any)).toEqual({ afterSeconds: 5 });
  });

  it("prefers an explicit `retry` over `retryAfterSeconds`", async () => {
    const { sdk, registrations } = createSdk();
    const retry = () => ({ acknowledge: true }) as const;
    await registerVercelQueueConsumer({
      sdk,
      topic: "orders",
      handler: vi.fn(),
      retry,
      retryAfterSeconds: 5,
    });
    expect(registrations[0].retry).toBe(retry);
  });

  it("falls back to importing `@vercel/queue` when no `sdk` is passed", async () => {
    const unregister = await registerVercelQueueConsumer({
      topic: "env-runner-optional-import",
      handler: vi.fn(),
    });
    // `@vercel/queue` is installed here, so the optional import resolves and a
    // real dev consumer is registered.
    expect(typeof unregister).toBe("function");
    unregister();
  });

  it("warns once and no-ops when the SDK cannot register dev consumers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sdk, clients } = createSdk({ registerDevConsumer: undefined });
      const first = await registerVercelQueueConsumer({ sdk, topic: "orders", handler: vi.fn() });
      const second = await registerVercelQueueConsumer({ sdk, topic: "other", handler: vi.fn() });

      expect(first()).toBeUndefined();
      expect(second()).toBeUndefined();
      expect(clients).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("registerDevConsumer");
    } finally {
      warn.mockRestore();
    }
  });
});
