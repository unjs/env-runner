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

/** Host-side Vite `HotChannel`, namespaced by `envName` so environments can share a runner. */
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

/** Worker-side Vite `ModuleRunner` transport, filtered by `envName` to share one IPC channel. */
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
