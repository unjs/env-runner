# env-runner

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/env-runner?color=yellow)](https://npmjs.com/package/env-runner)
[![npm downloads](https://img.shields.io/npm/dm/env-runner?color=yellow)](https://npm.chart.dev/env-runner)

<!-- /automd -->

Generic environment runner for JavaScript runtimes. Run your server apps across Node.js worker threads, child processes, Bun, Deno, Cloudflare Workers (via miniflare), Vercel, Netlify, or in-process — with hot-reload, WebSocket proxying, and bidirectional messaging.

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
  runner: "node-process", // optional, defaults to "node-worker"
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

// Optional — the server auto-starts on first fetch()
await envServer.start();

// Restart with a fresh runner created from the server options
await envServer.reload();

// Use with any HTTP server
const server = serve({
  fetch: (request) => envServer.fetch(request),
});
```

### Manager (`RunnerManager`)

Proxy manager for hot-reload with message queueing and listener forwarding:

```ts
import { RunnerManager, NodeProcessEnvRunner } from "env-runner";

await using manager = new RunnerManager();

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

// manager.close() is awaited automatically at the end of the scope (`await using`)
```

All runners, `RunnerManager`, and `EnvServer` implement `AsyncDisposable`, so they can be auto-closed with [explicit resource management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/await_using) (`await using`) — or closed manually with `await runner.close()`.

### Runners

Use runners directly for lower-level control:

```ts
import { NodeWorkerEnvRunner } from "env-runner/runners/node-worker";
import { NodeProcessEnvRunner } from "env-runner/runners/node-process";
import { BunProcessEnvRunner } from "env-runner/runners/bun-process";
import { DenoProcessEnvRunner } from "env-runner/runners/deno-process";
import { SelfEnvRunner } from "env-runner/runners/self";
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";
import { VercelEnvRunner } from "env-runner/runners/vercel";
import { NetlifyEnvRunner } from "env-runner/runners/netlify";
```

All runners implement the [`EnvRunner`](./src/types.ts) interface:

```ts
await using runner = new NodeProcessEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
  hooks: {
    onReady: (runner, address) => console.log("Listening on", address),
    onClose: (runner, cause) => console.log("Closed", cause),
  },
  execArgv: ["--inspect"], // Node.js flags (process-based runners)
});

// Proxy HTTP requests (retries with exponential backoff)
// Relative URLs are resolved against a placeholder origin
const response = await runner.fetch("/api");

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

// Invalidate a virtual module (re-runs a factory source), then reload
await runner.invalidateModule("#config.json");
await runner.reloadModule();

// Graceful shutdown happens automatically at the end of the scope
// (`await using`) — or call `await runner.close()` explicitly
```

**Available runners:**

| Runner                 | Isolation                       | IPC mechanism                      |
| ---------------------- | ------------------------------- | ---------------------------------- |
| `NodeWorkerEnvRunner`  | Worker thread                   | `workerData` / `parentPort`        |
| `NodeProcessEnvRunner` | Child process (`fork`)          | `ENV_RUNNER_DATA` / `process.send` |
| `BunProcessEnvRunner`  | Bun or Node.js process          | `Bun.spawn` IPC or `fork()`        |
| `DenoProcessEnvRunner` | Deno process                    | `deno run` with IPC channel        |
| `SelfEnvRunner`        | In-process                      | In-memory channel                  |
| `MiniflareEnvRunner`   | Cloudflare Workers (miniflare)  | WebSocket pair via `dispatchFetch` |
| `VercelEnvRunner`      | Worker thread (Vercel context)  | `workerData` / `parentPort`        |
| `NetlifyEnvRunner`     | Worker thread (Netlify context) | `workerData` / `parentPort`        |

#### Virtual Modules

The Node.js runners (`NodeWorkerEnvRunner`, `NodeProcessEnvRunner`, and the runners built on top of them), `BunProcessEnvRunner`, `DenoProcessEnvRunner` (Deno >= 2.x), and `MiniflareEnvRunner` can serve **virtual modules** from an in-memory `specifier => source` map passed via `data.virtual`. The entry (and its dependencies) can then `import` them as if they were real files:

```ts
import { NodeWorkerEnvRunner } from "env-runner/runners/node-worker";

await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: "./app.ts",
    virtual: {
      "#config": `export const apiBase = "https://api.example.com";`,
      "#banner": `export default "Hello from a virtual module!";`,
    },
  },
});
```

```ts
// app.ts
import banner from "#banner";
import { apiBase } from "#config";

export default {
  fetch: () => new Response(`${banner} (${apiBase})`),
};
```

The **entry itself can be virtual** — set `data.entry` to one of the `data.virtual` keys to run an entry whose source lives in memory (it may import other virtual modules too):

```ts
await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: "#entry",
    virtual: {
      "#entry": `import { body } from "#dep";
        export default { fetch: () => new Response(body) };`,
      "#dep": `export const body = "Hello from a virtual entry!";`,
    },
  },
});
```

Each source may also be a **factory** `() => string | Promise<string>` instead of a literal string — useful for lazily computed or asynchronously loaded sources:

```ts
await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: "./app.ts",
    virtual: {
      "#config": () => `export const apiBase = ${JSON.stringify(getApiBase())};`,
      "#schema": async () => `export default ${await loadSchemaJson()};`,
    },
  },
});
```

Factories are invoked once on the host (before the worker is spawned), so the worker always receives plain strings — functions can't cross the `workerData`/`JSON` boundary, and Node's synchronous load hook can't await. For the same reason, **all** factories are resolved eagerly at startup (in parallel), not lazily on first import — so keep them cheap, or use plain strings for sources that don't need computation. Maps containing only strings skip this step entirely.

To refresh a single virtual module without restarting the worker, call `invalidateModule(specifier)`: a factory-valued source is re-run on the host and the module is invalidated in the worker so its **next import evaluates fresh**. Virtual modules that import the invalidated one (directly or transitively) are invalidated along with it, so the fresh module is picked up even through intermediate virtual importers. Already-imported modules keep their instances, so pair it with `reloadModule()` to re-import the entry graph:

```ts
await runner.invalidateModule("#config"); // re-runs the factory, busts the module
await runner.reloadModule(); // re-imports the entry, picking up the fresh module
```

When fetching through `RunnerManager` or `EnvServer`, the reload is automatic: `invalidateModule()` marks the manager dirty and the next `fetch()` reloads the entry once before serving (concurrent fetches share the reload), so no explicit `reloadModule()` call is needed.

The module format is derived from the specifier extension: `.ts`/`.mts` sources are served as **TypeScript** and `.json` sources as **JSON modules**; everything else is plain JavaScript ESM:

```ts
await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: "#entry.ts",
    virtual: {
      "#entry.ts": `
        import { getGreeting } from "#util.ts";
        import config from "#config.json";
        const handler: () => Response = () => new Response(getGreeting(config.name));
        export default { fetch: handler };
      `,
      "#util.ts": `export function getGreeting(name: string): string {
        return \`Hello, \${name}!\`;
      }`,
      "#config.json": JSON.stringify({ name: "virtual" }),
    },
  },
});
```

- **TypeScript** is type-stripped by Node's native [type stripping](https://nodejs.org/api/typescript.html#type-stripping) (Node.js >= 22.18 / 23.6 — erasable syntax only) and by Bun's `ts` loader. On Deno, custom load hooks bypass its native type stripping, so sources are pre-stripped with [`module.stripTypeScriptTypes`](https://docs.deno.com/api/node/module/~/Module.stripTypeScriptTypes) (Deno >= 2.8.2); on older Deno without it, virtual `.ts`/`.mts` sources **throw at registration** — pass pre-transpiled JavaScript instead. On miniflare, sources are likewise pre-stripped with `module.stripTypeScriptTypes` on the host (workerd does not parse TypeScript).
- **JSON** sources expose the parsed value as the default export on all runtimes. The `with { type: "json" }` import attribute is optional on Node.js and Bun; on Deno and miniflare it must be **omitted** (static imports carrying an import attribute bypass `registerHooks` resolution on Deno, and workerd rejects import attributes outright).

Virtual modules are registered inside the worker, before the entry is imported. On Node.js (>= 22.15 / 23.5) and Deno (>= 2.x) this uses [ESM customization hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) (`module.registerHooks`); on Bun (which does not implement `registerHooks`) it uses [`Bun.plugin()`](https://bun.com/docs/runtime/plugins) virtual modules instead. The source string is treated as an ES module, and virtual specifiers (including a virtual entry) resolve across `reloadModule()`. On runtimes supporting neither mechanism, a warning is logged and registration is skipped. When the worker shuts down gracefully the registration is unregistered again (the `registerHooks` registration is deregistered; on Bun, which has no plugin-removal API, the in-memory source map is detached so fresh loads and reloads stop resolving).

On `MiniflareEnvRunner` there is no in-worker registration: the runner's module fallback service serves virtual specifiers to workerd directly (taking precedence over disk files and the `transformRequest` pipeline, so a virtual key overrides a real file with the same path). One limitation: named `exports` (Durable Objects / WorkerEntrypoints) cannot be combined with a **virtual entry** — the wrapper would need a static re-export that miniflare cannot resolve at startup — and the runner fails fast with a clear error in that case.

#### Miniflare Runner

Run your app in the Cloudflare Workers runtime using [miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare):

```bash
npm install miniflare
```

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  miniflareOptions: {
    compatibilityDate: "2024-01-01",
    kvNamespaces: ["MY_KV"],
  },
});

const response = await runner.fetch("http://localhost/api");
```

The `miniflareOptions` object is passed directly to the [Miniflare constructor](https://developers.cloudflare.com/workers/testing/miniflare/) — you can configure bindings, KV, D1, Durable Objects, and any other Miniflare option.

When you don't set a `compatibilityDate` (via `miniflareOptions` or a wrangler config), it defaults to the date supported by the installed `workerd` binary rather than today's date — the binary always lags the calendar slightly, and pinning a future date makes `workerd` refuse to start.

#### Wrangler Config

Set the `wrangler` option to load a Cloudflare [Wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) (`wrangler.json` / `wrangler.jsonc` / `wrangler.toml`) into the Miniflare options — compatibility date/flags and bindings (`vars`, KV, R2, D1, Durable Objects, queues):

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  wrangler: true, // auto-discover wrangler.{json,jsonc,toml} next to the entry, then cwd
  // wrangler: "./config/wrangler.toml", // or an explicit path
  // wranglerEnv: "production",          // select a `[env.production]` block
});
```

`wranglerEnv` selects a named Wrangler environment (`--env`). When omitted, it defaults to the `CLOUDFLARE_ENV` environment variable, so `CLOUDFLARE_ENV=production` selects the `production` env without passing the option.

You can also pass an **inline** config object (raw `wrangler.json` shape) instead of (or in addition to) a file — handy for programmatic setups:

```ts
await using runner = new MiniflareEnvRunner({
  name: "my-worker",
  data: { entry: "./worker.ts" },
  wrangler: {
    compatibility_date: "2024-09-01",
    compatibility_flags: ["nodejs_compat"],
    vars: { GREETING: "hello" },
    kv_namespaces: [{ binding: "MY_KV", id: "..." }],
  },
});
```

When an inline config is passed, a `wrangler.{json,jsonc,toml}` file is still auto-discovered (next to the entry, then cwd) and loaded, and the inline config is **merged on top of it** — inline values win per key, binding records (e.g. `vars`) merge, and `compatibilityFlags` are unioned. This lets you keep a committed `wrangler` file and override a few fields programmatically.

When the [`wrangler`](https://www.npmjs.com/package/wrangler) package is installed (an optional peer dependency), it is used for full fidelity — TOML, `env` inheritance, `.dev.vars`, and every binding type. When `wrangler` is **not** installed, a built-in minimal reader handles plain JSON files and inline objects (common fields only) and logs a one-time warning; JSONC and TOML files are skipped with a warning (they need `wrangler` to parse). Values you pass in `miniflareOptions` always take precedence over config-derived ones — binding records (e.g. `bindings`) merge per key, and `compatibilityFlags` are merged.

#### Module Transform Pipeline

Pass a `transformRequest` callback to route module resolution through Vite's (or any) transform pipeline. This enables TS, JSX, and other non-JS formats to be compiled on-the-fly inside the Workers runtime without pre-bundling:

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
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
await using runner = new MiniflareEnvRunner({
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

#### Vercel Runner

Simulates a Vercel deployment environment with automatic header injection (`x-vercel-deployment-url`, `x-vercel-forwarded-for`, forwarding headers) and global context.

```ts
import { VercelEnvRunner } from "env-runner/runners/vercel";

await using runner = new VercelEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
```

#### Netlify Runner

Simulates a Netlify deployment environment with automatic header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`, forwarding headers) and `globalThis.Netlify` setup:

```ts
import { NetlifyEnvRunner } from "env-runner/runners/netlify";

await using runner = new NetlifyEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
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
const runner = new ModuleRunner({
  transport,
  sourcemapInterceptor: "prepareStackTrace",
});
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

await using runner = await loadRunner("node-worker", {
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
await using runner = new NodeProcessEnvRunner({
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
