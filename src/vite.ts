import type { RunnerRPCHooks } from "./types.ts";

/** Vite HotChannel-compatible interface (avoids hard dependency on vite types). */
export interface ViteHotChannel {
  send: (data: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
}

/** Vite ModuleRunner transport-compatible interface. */
export interface ViteTransport {
  connect: (handlers: { onMessage: (payload: any) => void }) => void;
  send: (payload: any) => void;
}

/**
 * Create a Vite `HotChannel` from an env-runner's RPC hooks.
 *
 * Use on the **host side** to bridge env-runner IPC → Vite's DevEnvironment transport.
 * Messages are namespaced by `envName` so multiple Vite environments can share one runner.
 */
export function createViteHotChannel(hooks: RunnerRPCHooks, envName: string): ViteHotChannel {
  const listeners = new WeakMap<(...args: any[]) => void, (data: unknown) => void>();
  return {
    send: (data) => hooks.sendMessage({ ...data, viteEnv: envName }),
    on: (event: string, handler: any) => {
      if (event === "connection") return;
      const listener = (value: any) => {
        if (value?.type === "custom" && value.event === event && value.viteEnv === envName) {
          handler(value.data, {
            send: (payload: any) => hooks.sendMessage({ ...payload, viteEnv: envName }),
          });
        }
      };
      listeners.set(handler, listener);
      hooks.onMessage(listener);
    },
    off: (event, handler) => {
      if (event === "connection") return;
      const listener = listeners.get(handler);
      if (listener) {
        hooks.offMessage(listener);
        listeners.delete(handler);
      }
    },
  };
}

/**
 * Create a Vite `ModuleRunner` transport from worker-side IPC primitives.
 *
 * Use on the **worker side** to bridge worker IPC → Vite's `ModuleRunner` transport.
 * Filters messages by `envName` so multiple Vite environments can share one IPC channel.
 */
export function createViteTransport(
  sendMessage: (data: any) => void,
  onMessage: (listener: (value: any) => void) => void,
  envName: string,
): ViteTransport {
  return {
    connect({ onMessage: onRunnerMessage }) {
      onMessage((payload) => {
        if (payload?.type === "custom" && payload.viteEnv === envName) {
          onRunnerMessage(payload);
        }
      });
    },
    send(payload) {
      sendMessage?.({ ...payload, viteEnv: envName });
    },
  };
}
