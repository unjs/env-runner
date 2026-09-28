import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { PluginPipeline } from "./plugins.ts";

// Transform requests from worker loader hooks to the runner's plugins.
//
// Loader hooks are synchronous, so the worker blocks (`Atomics.wait`) until
// the runner replies, and the reply can't come through the runner IPC channel
// (its listener runs on the blocked thread). Each request instead goes over a
// dedicated channel, and the side answering bumps a shared counter and wakes
// the worker, which reads the reply with `receiveMessageOnPort()`:
//
// - node-worker: a `MessagePort` the runner answers directly.
// - process workers: a local socket the runner listens on (unix socket, or
//   named pipe on Windows), bridged by a helper thread in the worker.
//
// Messages: `{ id, path, code }` → `{ id, code?, moduleType? }` (no `code`:
// unchanged) or `{ id, error }`. The socket carries them as newline-delimited
// JSON.

export interface TransformRequest {
  id: number;
  /** Absolute file path. */
  path: string;
  code: string;
}

export interface TransformReply {
  id?: number;
  code?: string;
  moduleType?: "js" | "ts";
  error?: string;
  /** Set by the bridge when the socket closed (no `id`). */
  closed?: boolean;
}

/** How a worker reaches the runner's plugins (part of the runner data). */
export interface TransformChannel {
  port?: MessagePort;
  state?: Int32Array;
  socket?: string;
}

/** Runner side of an open channel. */
export interface TransformChannelHost {
  /** Sent to the worker (`port` must be in the transfer list). */
  channel: TransformChannel;
  close(): void;
}

/** Answer a request with the pipeline; never rejects. */
export async function handleTransformRequest(
  pipeline: PluginPipeline,
  request: TransformRequest,
): Promise<TransformReply> {
  try {
    const result = await pipeline.transform(request.path, request.code);
    return { id: request.id, code: result?.code, moduleType: result?.moduleType };
  } catch (error: any) {
    return { id: request.id, error: error?.message || String(error) };
  }
}

/** Runner side for worker threads: a `MessagePort` and a shared counter. */
export function openTransformPort(pipeline: PluginPipeline): TransformChannelHost {
  const { port1, port2 } = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(4));
  port1.on("message", async (request: TransformRequest) => {
    port1.postMessage(await handleTransformRequest(pipeline, request));
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
  });
  // Never keeps the host alive.
  port1.unref();
  return {
    channel: { port: port2, state },
    close: () => port1.close(),
  };
}

/**
 * Runner side for process workers: listen on a fresh local socket, in a
 * private (0700) temporary directory on POSIX. The worker connects after its
 * data handshake, by which time the socket is bound.
 */
export function openTransformSocket(pipeline: PluginPipeline): TransformChannelHost {
  const { path, dir } = _socketPath();
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        let request: TransformRequest;
        try {
          request = JSON.parse(buffer.slice(0, index));
        } catch {
          socket.destroy();
          return;
        }
        buffer = buffer.slice(index + 1);
        handleTransformRequest(pipeline, request).then((reply) => {
          if (!socket.destroyed) {
            socket.write(JSON.stringify(reply) + "\n");
          }
        });
      }
    });
  });
  server.on("error", (error) => {
    console.error(`[env-runner] plugin transform channel failed: ${error.message}`);
  });
  server.listen(path);
  server.unref();
  // Node doesn't unlink unix sockets, also not on exit.
  const cleanup = () => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.once("exit", cleanup);
  return {
    channel: { socket: path },
    close: () => {
      server.close();
      process.off("exit", cleanup);
      cleanup();
    },
  };
}

function _socketPath(): { path: string; dir?: string } {
  if (process.platform === "win32") {
    const name = `env-runner-${process.pid}-${crypto.randomUUID()}`;
    return { path: `\\\\.\\pipe\\${name}` };
  }
  // Unix socket paths are limited to ~104 bytes (macOS) / 108 (Linux).
  let base = tmpdir();
  if (join(base, "env-runner-XXXXXX", "transform.sock").length >= 100) {
    base = "/tmp";
  }
  const dir = mkdtempSync(join(base, "env-runner-"));
  return { path: join(dir, "transform.sock"), dir };
}

/** New code from the runner, `ts` when it still needs type stripping. */
export interface TransformedCode {
  code: string;
  moduleType: "js" | "ts";
}

// A transform taking longer than this logs a warning (once per module).
const SLOW_TRANSFORM_MS = 10_000;

/**
 * Worker side: a synchronous `transform(path, code)` over the channel,
 * returning the new code, or `undefined` when unchanged. Throws plugin errors.
 */
export function createTransformClient(
  channel: TransformChannel,
): (path: string, code: string) => TransformedCode | undefined {
  let port: MessagePort;
  let state: Int32Array;
  if (channel.port && channel.state) {
    ({ port, state } = channel);
  } else if (channel.socket) {
    const pair = new MessageChannel();
    port = pair.port1;
    state = new Int32Array(new SharedArrayBuffer(4));
    // An eval worker, so it needs no file of its own next to the bundle.
    const bridge = new Worker(BRIDGE_SOURCE, {
      eval: true,
      workerData: { port: pair.port2, state, socket: channel.socket },
      transferList: [pair.port2],
    });
    bridge.unref();
  } else {
    throw new TypeError("[env-runner] invalid plugin transform channel");
  }
  let lastId = 0;
  return (path, code) => {
    const id = ++lastId;
    port.postMessage({ id, path, code } satisfies TransformRequest);
    let warned = false;
    for (;;) {
      // Read before receiving: a reply posted after the read bumps the counter,
      // so the wait below returns at once.
      const seen = Atomics.load(state, 0);
      const received = receiveMessageOnPort(port);
      if (!received) {
        if (Atomics.wait(state, 0, seen, SLOW_TRANSFORM_MS) === "timed-out" && !warned) {
          warned = true;
          console.warn(
            `[env-runner] still waiting for the runner's plugins to transform "${path}" (plugin handlers must not wait on this runner).`,
          );
        }
        continue;
      }
      const reply = received.message as TransformReply;
      if (reply.closed) {
        throw new Error(`[env-runner] cannot transform "${path}": ${reply.error}`);
      }
      // Replies to earlier requests can't be pending (requests are sequential).
      if (reply.id !== id) {
        continue;
      }
      if (reply.error !== undefined) {
        throw new Error(reply.error);
      }
      return reply.code === undefined
        ? undefined
        : { code: reply.code, moduleType: reply.moduleType ?? "js" };
    }
  };
}

// Helper thread for process workers: relays requests to the runner's socket.
// A CommonJS eval source (a function's `toString()` could be rewritten by
// the bundler).
const BRIDGE_SOURCE = /* js */ `
const { workerData } = require("node:worker_threads");
const { connect } = require("node:net");
const { port, state, socket } = workerData;
// A crash here would leave the worker blocked: answer with an error instead.
process.on("uncaughtException", (error) => onClose(error));
const reply = (message) => {
  port.postMessage(message);
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
};
let closed = false;
const onClose = (error) => {
  if (!closed) {
    closed = true;
    reply({ closed: true, error: "the runner closed the channel" + (error ? " (" + error.message + ")" : "") });
  }
};
let buffer = "";
const connection = connect(socket);
connection.setEncoding("utf8");
connection.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    reply(JSON.parse(buffer.slice(0, index)));
    buffer = buffer.slice(index + 1);
  }
});
connection.on("error", onClose);
connection.on("close", () => onClose());
port.on("message", (request) => {
  if (closed) {
    reply({ closed: true, error: "the runner closed the channel" });
  } else {
    connection.write(JSON.stringify(request) + "\\n");
  }
});
`;
