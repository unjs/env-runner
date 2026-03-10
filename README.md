# env-runner

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/env-runner?color=yellow)](https://npmjs.com/package/env-runner)
[![npm downloads](https://img.shields.io/npm/dm/env-runner?color=yellow)](https://npm.chart.dev/env-runner)

<!-- /automd -->

Generic environment runner for Node.js. Run your server apps in isolated worker threads, child processes, or in-process — with hot-reload, WebSocket proxying, and bidirectional messaging.

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

| Flag              | Description                                                          | Default        |
| ----------------- | -------------------------------------------------------------------- | -------------- |
| `--runner <name>` | Runner to use (`node-worker`, `node-process`, `bun-process`, `self`) | `node-process` |
| `--port <port>`   | Port to listen on                                                    | `3000`         |
| `--host <host>`   | Host to bind to                                                      | `localhost`    |
| `-w, --watch`     | Watch entry file for changes and auto-reload                         |                |

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

envServer.onReady = (_runner, address) => {
  console.log(`Worker ready on ${address?.host}:${address?.port}`);
};

envServer.onReload = () => {
  console.log("Reloaded!");
};

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

manager.onReady = (_runner, address) => {
  console.log("Ready:", address);
};

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
import { SelfEnvRunner } from "env-runner/runners/self";
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

// Bidirectional messaging
runner.sendMessage({ type: "ping" });
runner.onMessage((msg) => console.log(msg));

// Graceful shutdown
await runner.close();
```

**Available runners:**

| Runner                 | Isolation              | IPC mechanism                      |
| ---------------------- | ---------------------- | ---------------------------------- |
| `NodeWorkerEnvRunner`  | Worker thread          | `workerData` / `parentPort`        |
| `NodeProcessEnvRunner` | Child process (`fork`) | `ENV_RUNNER_DATA` / `process.send` |
| `BunProcessEnvRunner`  | Bun or Node.js process | `Bun.spawn` IPC or `fork()`        |
| `SelfEnvRunner`        | In-process             | In-memory channel                  |

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
  middleware: [], // Optional srvx middleware
  plugins: [], // Optional srvx plugins
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
