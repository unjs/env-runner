import { describe, expect, it } from "vitest";
import { createViteHotChannel, createViteTransport } from "../src/vite.ts";
import type { RunnerRPCHooks } from "../src/types.ts";

function createMockHooks(): RunnerRPCHooks & {
  messages: unknown[];
  listeners: Set<(data: unknown) => void>;
} {
  const listeners = new Set<(data: unknown) => void>();
  const messages: unknown[] = [];
  return {
    messages,
    listeners,
    sendMessage: (message: unknown) => messages.push(message),
    onMessage: (listener) => listeners.add(listener),
    offMessage: (listener) => listeners.delete(listener),
  };
}

describe("createViteHotChannel", () => {
  it("send namespaces messages with viteEnv", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");
    channel.send({ type: "custom", event: "test" });
    expect(hooks.messages).toEqual([{ type: "custom", event: "test", viteEnv: "ssr" }]);
  });

  it("on registers listener filtered by event and envName", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");

    const received: unknown[] = [];
    channel.on("my-event", (data: unknown) => received.push(data));

    expect(hooks.listeners.size).toBe(1);

    // Simulate incoming messages
    const listener = [...hooks.listeners][0]!;

    // Wrong env — should be ignored
    listener({ type: "custom", event: "my-event", viteEnv: "other", data: "no" });
    expect(received).toHaveLength(0);

    // Wrong event — should be ignored
    listener({ type: "custom", event: "other-event", viteEnv: "ssr", data: "no" });
    expect(received).toHaveLength(0);

    // Matching — should fire
    listener({ type: "custom", event: "my-event", viteEnv: "ssr", data: "yes" });
    expect(received).toEqual(["yes"]);
  });

  it("on ignores connection event", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");
    channel.on("connection", () => {});
    expect(hooks.listeners.size).toBe(0);
  });

  it("off removes the listener", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");

    const handler = () => {};
    channel.on("test", handler);
    expect(hooks.listeners.size).toBe(1);

    channel.off("test", handler);
    expect(hooks.listeners.size).toBe(0);
  });

  it("off ignores connection event", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");
    channel.off("connection", () => {});
    // Should not throw
  });

  it("handler receives send callback for reply", () => {
    const hooks = createMockHooks();
    const channel = createViteHotChannel(hooks, "ssr");

    let client: any;
    channel.on("request", (_data: unknown, c: any) => {
      client = c;
    });

    const listener = [...hooks.listeners][0]!;
    listener({ type: "custom", event: "request", viteEnv: "ssr", data: "req" });

    expect(client).toBeDefined();
    client.send({ type: "custom", event: "response", data: "res" });
    expect(hooks.messages).toEqual([
      { type: "custom", event: "response", data: "res", viteEnv: "ssr" },
    ]);
  });
});

describe("createViteTransport", () => {
  it("connect filters messages by envName", () => {
    const sent: unknown[] = [];
    const listeners: ((data: unknown) => void)[] = [];
    const sendMessage = (data: unknown) => sent.push(data);
    const onMessage = (listener: (data: unknown) => void) => listeners.push(listener);

    const transport = createViteTransport(sendMessage, onMessage, "nitro");

    const received: unknown[] = [];
    transport.connect({ onMessage: (payload) => received.push(payload) });

    expect(listeners).toHaveLength(1);

    // Wrong env — filtered
    listeners[0]!({ type: "custom", event: "test", viteEnv: "other" });
    expect(received).toHaveLength(0);

    // Matching env
    listeners[0]!({ type: "custom", event: "test", viteEnv: "nitro", data: "ok" });
    expect(received).toEqual([{ type: "custom", event: "test", viteEnv: "nitro", data: "ok" }]);
  });

  it("send namespaces messages with viteEnv", () => {
    const sent: unknown[] = [];
    const sendMessage = (data: unknown) => sent.push(data);
    const onMessage = () => {};

    const transport = createViteTransport(sendMessage, onMessage, "nitro");
    transport.send({ type: "custom", event: "hmr" });

    expect(sent).toEqual([{ type: "custom", event: "hmr", viteEnv: "nitro" }]);
  });
});
