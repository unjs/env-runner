import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** Handler for proxying HTTP requests to the worker. */
export type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Callback for receiving messages from the worker. */
export type RunnerMessageListener = (data: unknown) => void;

/** Raw Node.js upgrade request context. */
export interface NodeUpgradeContext {
  req: IncomingMessage;
  socket: Socket;
  head: any;
}

/** Context passed to the upgrade handler for WebSocket upgrades. */
export interface UpgradeContext {
  node: NodeUpgradeContext;
}

/** Handler for proxying WebSocket upgrade requests to the worker. */
export type UpgradeHandler = (context: UpgradeContext) => void;

/** Bidirectional RPC messaging interface between the runner and worker. */
export interface RunnerRPCHooks {
  /** Send a message to the worker. */
  sendMessage: (message: unknown) => void;

  /** Register a listener for messages from the worker. */
  onMessage: (listener: RunnerMessageListener) => void;

  /** Remove a previously registered message listener. */
  offMessage: (listener: RunnerMessageListener) => void;
}

/**
 * Address reported by the worker once it is ready.
 *
 * Either a TCP `host`/`port` pair or a Unix `socketPath`.
 */
export type WorkerAddress =
  | { host?: string; port: number; socketPath?: undefined }
  | { host?: undefined; port?: undefined; socketPath: string };

/** Lifecycle hooks for observing runner state changes. */
export interface WorkerHooks {
  /** Called when the worker closes, optionally with the cause. */
  onClose?: (worker: EnvRunner, cause?: unknown) => void;

  /** Called when the worker is ready and listening at the given address. */
  onReady?: (worker: EnvRunner, address?: WorkerAddress) => void;
}

/** Options for the `rpc()` method. */
export interface RPCOptions {
  /** Timeout in milliseconds before the RPC call rejects. Default: 3000. */
  timeout?: number;
}

/** Core runner interface combining lifecycle hooks, RPC, and request proxying. */
export interface EnvRunner extends RunnerRPCHooks {
  /** Whether the worker is ready to accept requests. */
  readonly ready: boolean;

  /** Whether the runner has been closed. */
  readonly closed: boolean;

  /** Proxy an HTTP request to the worker. */
  fetch: FetchHandler;

  /** Proxy a WebSocket upgrade request to the worker. */
  upgrade?: UpgradeHandler;

  /** Returns a promise that resolves when the runner becomes ready. */
  waitForReady(timeout?: number): Promise<void>;

  /** Send an RPC request and wait for the response. */
  rpc<T = unknown>(name: string, data?: unknown, opts?: RPCOptions): Promise<T>;

  /** Re-import the entry module without restarting the worker/process. */
  reloadModule?(timeout?: number): Promise<void>;

  /** Gracefully shut down the worker. */
  close(): Promise<void>;
}
