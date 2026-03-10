# env-runner

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/env-runner?color=yellow)](https://npmjs.com/package/env-runner)
[![npm downloads](https://img.shields.io/npm/dm/env-runner?color=yellow)](https://npm.chart.dev/env-runner)

<!-- /automd -->

Generic environment runner for JavaScript runtimes. Run your server apps across Node.js worker threads, child processes, Bun, Deno, Cloudflare Workers (via miniflare), or in-process — with hot-reload, WebSocket proxying, and bidirectional messaging.

## Usage

### App Entry

Create a server entry module that exports a `fetch` handler:

```ts
// app.ts
export default {
  fetch(request: Request) {
    return new Response("Hello!");
  },
};
```

### CLI

The quickest way to run your app:

```bash
npx env-runner app.ts
```

**Flags:**

| Flag              | Description                                                                                       | Default        |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| `--runner <name>` | Runner to use (`node-worker`, `node-process`, `bun-process`, `deno-process`, `self`, `miniflare`) | `node-process` |
| `--port <port>`   | Port to listen on                                                                                 | `3000`         |
| `--host <host>`   | Host to bind to                                                                                   | `localhost`    |
| `-w, --watch`     | Watch entry file for changes and auto-reload                                                      |                |

### Server (`EnvServer`)

High-level API that combines runner loading, file watching, and auto-reload:

```ts
import { serve } from "srvx";
import { EnvServer } from "env-runner";

const envServer = new EnvServer({
  runner: "node-process",
  entry: "./app.ts",
  watch: true,
  watchPaths: ["./src"],
});

envServer.onReady((_runner, address) => {
  console.log(`Worker ready on ${address?.host}:${address?.port}`);
});

envServer.onReload(() => {
  console.log("Reloaded!");
});

await envServer.start();

// Use with any HTTP server
const server = serve({
  fetch: (request) => envServer.fetch(request),
});
```

### Manager (`RunnerManager`)

Proxy manager for hot-reload with message queueing and listener forwarding:

```ts
import { RunnerManager, NodeProcessEnvRunner } from "env-runner";

const manager = new RunnerManager();

manager.onReady((_runner, address) => {
  console.log("Ready:", address);
});

// Load initial runner
const runner = new NodeProcessEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
await manager.reload(runner);

// Proxy requests
const response = await manager.fetch("http://localhost/hello");

// Hot-reload with a new runner
const newRunner = new NodeProcessEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
await manager.reload(newRunner); // old runner is closed automatically

// Bidirectional messaging (queued until runner is ready)
manager.sendMessage({ type: "config", value: 42 });
manager.onMessage((msg) => console.log("From worker:", msg));

await manager.close();
```

### Runners

Use runners directly for lower-level control:

```ts
import { NodeWorkerEnvRunner } from "env-runner/runners/node-worker";
import { NodeProcessEnvRunner } from "env-runner/runners/node-process";
import { BunProcessEnvRunner } from "env-runner/runners/bun-process";
import { DenoProcessEnvRunner } from "env-runner/runners/deno-process";
import { SelfEnvRunner } from "env-runner/runners/self";
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";
```

All runners implement the [`EnvRunner`](./src/types.ts) interface:

```ts
const runner = new NodeProcessEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
  hooks: {
    onReady: (runner, address) => console.log("Listening on", address),
    onClose: (runner, cause) => console.log("Closed", cause),
  },
  execArgv: ["--inspect"], // Node.js flags (process-based runners)
});

// Proxy HTTP requests (retries with exponential backoff)
const response = await runner.fetch("http://localhost/api");

// Proxy WebSocket upgrades
runner.upgrade?.({ node: { req, socket, head } });

// Wait for runner to be ready
await runner.waitForReady();

// Bidirectional messaging
runner.sendMessage({ type: "ping" });
runner.onMessage((msg) => console.log(msg));

// Request-response RPC
const result = await runner.rpc<string>("transformHTML", "<html>...</html>");

// Hot-reload entry module without restarting the worker
await runner.reloadModule();

// Graceful shutdown
await runner.close();
```

**Available runners:**

| Runner                 | Isolation                      | IPC mechanism                      |
| ---------------------- | ------------------------------ | ---------------------------------- |
| `NodeWorkerEnvRunner`  | Worker thread                  | `workerData` / `parentPort`        |
| `NodeProcessEnvRunner` | Child process (`fork`)         | `ENV_RUNNER_DATA` / `process.send` |
| `BunProcessEnvRunner`  | Bun or Node.js process         | `Bun.spawn` IPC or `fork()`        |
| `DenoProcessEnvRunner` | Deno process                   | `deno run` with IPC channel        |
| `SelfEnvRunner`        | In-process                     | In-memory channel                  |
| `MiniflareEnvRunner`   | Cloudflare Workers (miniflare) | WebSocket pair via `dispatchFetch` |

#### Miniflare Runner

Run your app in the Cloudflare Workers runtime using [miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare):

```bash
npm install miniflare
```

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

const runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  miniflareOptions: {
    compatibilityDate: "2024-01-01",
    kvNamespaces: ["MY_KV"],
  },
});

const response = await runner.fetch("http://localhost/api");
await runner.close();
```

The `miniflareOptions` object is passed directly to the [Miniflare constructor](https://developers.cloudflare.com/workers/testing/miniflare/) — you can configure bindings, KV, D1, Durable Objects, and any other Miniflare option.

#### Module Transform Pipeline

Pass a `transformRequest` callback to route module resolution through Vite's (or any) transform pipeline. This enables TS, JSX, and other non-JS formats to be compiled on-the-fly inside the Workers runtime without pre-bundling:

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

const runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  // Route module resolution through Vite's transform pipeline
  transformRequest: (id) => viteDevEnvironment.transformRequest(id),
});
```

When `transformRequest` is provided:

- The `unsafeModuleFallbackService` calls it with the resolved file path before falling back to raw disk reads
- Module rules for `.ts`, `.tsx`, `.jsx`, and `.mts` are added automatically
- Static `export *` re-exports are skipped in the wrapper to avoid miniflare's ModuleLocator pre-walking the import tree

The callback should return `{ code: string }` for transformed modules, or `null`/`undefined` to fall back to the default raw file read.

#### Auto-detected Exports

`MiniflareEnvRunner` automatically scans the entry file for `export class` declarations and wires them as Durable Object bindings (binding name = class name). This means you don't need to manually configure `miniflareOptions.durableObjects` for simple cases:

```ts
// worker.ts
export class Counter {
  /* ... Durable Object implementation ... */
}

export default {
  async fetch(request, env) {
    // env.Counter is auto-wired — no manual config needed
    const id = env.Counter.idFromName("test");
    const stub = env.Counter.get(id);
    return stub.fetch(request);
  },
};
```

To explicitly declare exports or override auto-detection:

```ts
const runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  // Explicit exports (merged with auto-detected ones)
  exports: { Counter: { type: "DurableObject" } },
});
```

Set `exports: false` to disable auto-detection entirely.

#### Error Capture

By default, the runner wraps the user's `fetch` handler in a try/catch that returns structured JSON error responses with preserved stack traces:

```json
{
  "error": "Cannot read properties of undefined",
  "stack": "Error: Cannot read properties...\n    at fetch (worker.ts:10:5)",
  "name": "TypeError"
}
```

Error responses include `Content-Type: application/json` and `X-Env-Runner-Error: 1` headers. Disable with `captureErrors: false`.

#### Persistent Miniflare

By default, `close()` disposes the Miniflare instance. With `persistent: true`, the Miniflare instance is cached and reused across runner swaps — only the IPC connection is re-established:

```ts
const runner1 = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  persistent: true,
});

// Later, after close() + creating a new runner with the same config,
// the Miniflare instance is reused (faster startup)
await runner1.close();

const runner2 = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  persistent: true,
});

// Fully destroy: runner.dispose() or MiniflareEnvRunner.disposeAll()
```

### Vite Environment API

env-runner provides helpers for integrating with Vite's [Environment API](https://vite.dev/guide/api-environment-runtimes.html):

```ts
import { createViteHotChannel, createViteTransport } from "env-runner/vite";
```

**Host side** — create a Vite `HotChannel` from any runner's messaging hooks:

```ts
import { createViteHotChannel } from "env-runner/vite";

// Bridge env-runner IPC → Vite's DevEnvironment transport
const transport = createViteHotChannel(runner, "ssr");
const env = new DevEnvironment("ssr", config, { hot: true, transport });
```

**Worker side** — create a `ModuleRunner` transport:

```ts
import { createViteTransport } from "env-runner/vite";

const transport = createViteTransport(sendMessage, onMessage, "ssr");
const runner = new ModuleRunner({ transport, sourcemapInterceptor: "prepareStackTrace" });
```

Messages are namespaced by environment name, so multiple Vite environments can share a single runner's IPC channel.

**Miniflare + Vite** — combine `MiniflareEnvRunner.transformRequest` with Vite helpers for a full Cloudflare Workers dev environment with HMR and on-the-fly transforms:

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";
import { createViteHotChannel } from "env-runner/vite";

const runner = new MiniflareEnvRunner({
  name: "worker",
  data: { entry: "./src/worker.ts" },
  transformRequest: (id) => devEnvironment.transformRequest(id),
});

const hotChannel = createViteHotChannel(runner, "worker");
```

### RPC

Send request-response messages over IPC with automatic ID generation, timeout, and error propagation:

```ts
// Host side
const html = await runner.rpc<string>("transformHTML", rawHtml, { timeout: 5000 });

// Worker side (in entry's ipc.onMessage)
onMessage(msg) {
  if (msg?.__rpc === "transformHTML") {
    const result = await transform(msg.data);
    sendMessage({ __rpc_id: msg.__rpc_id, data: result });
  }
}
```

Errors can be propagated back by sending `{ __rpc_id, error: "message" }`.

### Dynamic Runner Loading

You can also use `loadRunner()` to dynamically load a runner by name:

```ts
import { loadRunner } from "env-runner";

const runner = await loadRunner("node-worker", {
  name: "my-app",
  data: { entry: "./app.ts" },
});
```

### Workers

Each IPC-based runner includes a built-in worker that handles the srvx server boilerplate. You just provide an entry module:

```ts
// app.ts
export default {
  fetch(request: Request) {
    return new Response("Hello!");
  },
  websocket: {
    // Optional: crossws WebSocket hooks (recommended)
    open(peer) {
      peer.send("Welcome!");
    },
    message(peer, message) {
      peer.send(`Echo: ${message.text()}`);
    },
    close(peer, details) {},
    error(peer, error) {},
  },
  upgrade(context) {
    // Optional: raw WebSocket upgrade handler (Node.js only)
    // context.node gives { req, socket, head }
  },
  middleware: [], // Optional srvx middleware
  plugins: [], // Optional srvx plugins
  ipc: {
    onOpen({ sendMessage }) {
      // IPC channel is ready — send messages back to the runner
      sendMessage({ type: "hello", from: "worker" });
    },
    onMessage(message) {
      // Receive messages from the runner
      console.log("Got message:", message);
    },
    onClose() {
      // Runner is shutting down
    },
  },
};
```

The built-in worker automatically:

1. Imports your entry module
2. Starts a [srvx](https://srvx.h3.dev) server on a random port
3. Reports the address back to the runner via IPC
4. Handles graceful shutdown

For advanced use cases, you can provide a custom worker entry:

```ts
const runner = new NodeProcessEnvRunner({
  name: "my-app",
  workerEntry: "/path/to/custom-worker.ts",
  data: { entry: "./app.ts" },
});
```

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

</details>

## License

Published under the [MIT](https://github.com/unjs/env-runner/blob/main/LICENSE) license 💛.
