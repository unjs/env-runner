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

`--runner miniflare` needs `miniflare` installed in your project — the runner imports it optionally when no module is passed.

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
  // Runner-specific constructor options, e.g. `{ miniflare }` for `runner: "miniflare"`
  runnerOptions: {},
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
  // Proxy WebSocket upgrades to the worker (see "WebSocket proxying" below)
  plugins: [await envServer.wsSrvxPlugin()],
});
```

#### WebSocket proxying

To proxy WebSocket upgrades to the worker, attach the plugin returned by
`wsSrvxPlugin()` (available on both `RunnerManager` and `EnvServer`) to your
[srvx](https://srvx.h3.dev) server:

```ts
const server = serve({
  fetch: (request) => envServer.fetch(request),
  plugins: [await envServer.wsSrvxPlugin()],
});
```

The plugin picks the proxy strategy by **host** runtime:

- **Node** — proxies the raw upgrade socket to the worker (transparent
  passthrough; subprotocol/extension negotiation stays end-to-end).
- **Bun/Deno** — those runtimes serve natively and expose no Node upgrade
  socket, so the client WebSocket is terminated with [crossws](https://crossws.h3.dev)
  and bridged to the worker over a standard `WebSocket` client.

It reads the active runner lazily, so it keeps working across hot-reloads, and
waits for the worker to become ready before proxying. Your entry module should
expose WebSocket hooks via the `websocket` field (see [Workers](#workers)).

### Manager (`RunnerManager`)

Proxy manager for hot-reload with message queueing and listener forwarding:

```ts
import { RunnerManager } from "env-runner";
import { NodeProcessEnvRunner } from "env-runner/runners/node-process";

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

#### Runtime dependencies

`env-runner` declares **no peer dependencies**. Runners that build on external packages take them as explicit options instead, and every such option accepts the **same three shapes**:

| Value                                                                       | Meaning                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| the imported module (`import * as miniflare from "miniflare"`)              | the version you installed is the version that runs                                                          |
| a specifier — `"miniflare"`, `import.meta.resolve("miniflare")`, or a `URL` | resolved from the current working directory, so bare specifiers hit your `node_modules`, not `env-runner`'s |
| `false`                                                                     | opt out of the package entirely                                                                             |

Omitting the option falls back to an optional dynamic import of the package; only then does the runner error (`miniflare`) or degrade (minimal wrangler reader, Netlify shim, queue no-op).

| Runner      | Package            | Option                                   | Without it                            |
| ----------- | ------------------ | ---------------------------------------- | ------------------------------------- |
| `miniflare` | `miniflare`        | `miniflare`                              | throws — the runner cannot run        |
| `miniflare` | `wrangler`         | `wranglerModule`                         | built-in minimal JSON reader          |
| `vercel`    | `@vercel/queue`    | `sdk` (on `registerVercelQueueConsumer`) | warn-once no-op                       |
| `netlify`   | `@netlify/runtime` | `netlifyRuntime`                         | lightweight `globalThis.Netlify` shim |

`netlifyRuntime` is the one exception to the table above: the runtime has to start **inside** the worker thread, where a live module instance cannot be handed over, so it accepts a specifier (or `false`) only.

The shared resolver is exported as `resolveRuntimeDep()` (type `RuntimeDep<T>`) if you build runners of your own.

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

// Proxy a raw WebSocket upgrade to the worker (Node host only — low-level;
// prefer `manager.wsSrvxPlugin()` for cross-runtime proxying)
runner.upgrade?.({ node: { req, socket, head } });

// Wait for runner to be ready (rejects as soon as it closes, with the close
// reason as `error.cause`)
await runner.waitForReady();

// Bidirectional messaging
runner.sendMessage({ type: "ping" });
runner.onMessage((msg) => console.log(msg));

// Request-response RPC
const result = await runner.rpc<string>("transformHTML", "<html>...</html>");

// Hot-reload entry module without restarting the worker (the entry is
// re-read under its own URL; modules it imports stay cached)
await runner.reloadModule();

// Add, replace or remove (`null`) virtual modules in one round trip, then reload
await runner.updateVirtualModules({ "#routes": `export default []`, "#old": null });
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
| `NodeProcessEnvRunner` | Child process (`fork`)          | `process.send` IPC channel         |
| `BunProcessEnvRunner`  | Bun or Node.js process          | `Bun.spawn` IPC or `fork()`        |
| `DenoProcessEnvRunner` | Deno process                    | `deno run` with IPC channel        |
| `SelfEnvRunner`        | In-process                      | In-memory channel                  |
| `MiniflareEnvRunner`   | Cloudflare Workers (miniflare)  | WebSocket pair via `dispatchFetch` |
| `VercelEnvRunner`      | Worker thread (Vercel context)  | `workerData` / `parentPort`        |
| `NetlifyEnvRunner`     | Worker thread (Netlify context) | `workerData` / `parentPort`        |

#### Virtual Modules

The Node.js runners (`NodeWorkerEnvRunner`, `NodeProcessEnvRunner`, and the runners built on top of them), `BunProcessEnvRunner`, `DenoProcessEnvRunner` (Deno >= 2.8), and `MiniflareEnvRunner` can serve **virtual modules** from an in-memory `specifier => source` map passed via `data.virtual` (`SelfEnvRunner` cannot, and closes with an error when it is set). The entry (and its dependencies) can then `import` them as if they were real files:

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

The **entry itself can be virtual** — set `data.entry` to one of the `data.virtual` keys (exactly as written in the map) to run an entry whose source lives in memory (it may import other virtual modules too):

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

Keys can also be **file paths**: absolute paths (including Windows `C:\...`) or `file://` URLs. Such a module behaves like a file at that path, whether or not its directory exists on disk:

- it is matched by resolved URL, so any relative or absolute import that resolves to it is served from the map, whether the importer is a virtual module or a real file. A key equal to a real file's path therefore **overrides that file** for every importer.
- it runs under its real `file:` URL, so `import.meta.url`, `import.meta.dirname` and `import.meta.filename` point at the key.
- its own imports (relative files, bare packages) resolve from the key's directory.
- as `data.entry`, it may be written either way (`/app/x.mjs` for a `file:///app/x.mjs` key, or the reverse). It is still run from the map on load and across `reloadModule()`, even when a real file exists there.

```ts
import { join, resolve } from "node:path";

const dir = resolve("src/generated"); // doesn't need to exist

await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: join(dir, "entry.mjs"),
    virtual: {
      [join(dir, "entry.mjs")]: `import { body } from "./body.mjs";
        export default { fetch: () => new Response(body) };`,
      [join(dir, "body.mjs")]: `export const body = "Hello from " + import.meta.filename;`,
      // Overrides the real `src/config.mjs` for all of its importers
      [resolve("src/config.mjs")]: `export default { mode: "virtual" };`,
    },
  },
});
```

Other keys (`#name`, bare names) only match an import specifier equal to the key, and relative imports inside them resolve from the working directory. Having no file, they get a runtime-specific id, shown by `import.meta.url` and stack traces: `virtual:#config` on Node.js and Deno, `file:///%23config` on Bun (`file:///env-runner-virtual:%23util.mjs` for keys with an extension), while on miniflare `import.meta.url` is undefined and stack traces show the key itself. A `?query` appended to an import is ignored for matching (`#config.json?raw` matches `#config.json`), but gives a separate module instance. Path keys are fully supported on the Node.js, Bun and Deno runners, with these exceptions:

- On Bun (`BunProcessEnvRunner`, and the Node.js runners when the host runtime is Bun), runtime plugins only see a specifier whose last `.` is followed by a letter, typically a file extension. A key without an extension (`#config`, `/app/entry`) therefore only matches an import spelled exactly like the key: no appended `?query`, and no relative or `file://` import of an extensionless path key.
- `MiniflareEnvRunner` supports relative imports and overrides, and treats `file://` keys and imports like their path, but `import.meta.url` is undefined.

On both, a virtual `data.entry` must be written exactly like its key.

Two path keys naming the same file (`/app/x.mjs` and `file:///app/x.mjs`) can't both be served, so the runner logs a warning naming both. Keep a single key per file.

Keys match **every importer** in the worker, dependencies included, like an import map entry. A bare key such as `react` replaces that package everywhere (useful to alias or stub it), and a `#name` key also replaces a dependency's own `#name` [subpath import](https://nodejs.org/api/packages.html#subpath-imports). There is no warning for this, since overriding a package is often the point, so give your own modules distinctive names (`#app/config` rather than `#utils`).

Each source may also be a **factory** returning a source (or a promise of one) — useful for lazily computed or asynchronously loaded sources:

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

Factories are invoked once on the host (before the worker is spawned), so the worker always receives resolved sources — functions can't cross the `workerData`/`JSON` boundary, and Node's synchronous load hook can't await. For the same reason, **all** factories are resolved eagerly at startup (in parallel), not lazily on first import — so keep them cheap, or use plain sources for modules that don't need computation. Maps without factories skip this step entirely.

To refresh a single virtual module without restarting the worker, call `invalidateModule(specifier)`: a factory-valued source is re-run on the host and the module is invalidated in the worker so its **next import evaluates fresh**. Virtual modules that import the invalidated one (directly or transitively) are invalidated along with it, so the fresh module is picked up even through intermediate virtual importers. On Node.js, Bun and Deno this follows the imports that were actually resolved, and on miniflare the import specifiers of the virtual sources, including relative ones between path keys. On Node.js and Deno it also covers **real files** on the way from the entry, such as a `./lib.mjs` importing `#config`: they are re-evaluated on the next reload too, while files that don't depend on the module stay cached. CommonJS files are never re-evaluated. On Bun and miniflare, a real file other than the entry keeps the old module. Already-imported modules keep their instances, so pair it with `reloadModule()` to re-import the entry graph:

```ts
await runner.invalidateModule("#config"); // re-runs the factory, busts the module
await runner.reloadModule(); // re-imports the entry, picking up the fresh module
```

When fetching through `RunnerManager` or `EnvServer`, the reload is automatic: `invalidateModule()` marks the manager dirty and the next `fetch()` reloads the entry once before serving (concurrent fetches share the reload), so no explicit `reloadModule()` call is needed.

To change the map itself while the runner is running, call `updateVirtualModules(changes)`. A source (string or factory) **adds or replaces** a key, and `null` **removes** it. All changes of one call are applied together in a single round trip to the worker:

```ts
await runner.updateVirtualModules({
  "#routes": `export default ["/", "/about"]`, // add or replace
  [resolve("src/generated/api.mjs")]: () => generateApi(), // factories run on the host
  "#legacy": null, // remove
});
await runner.reloadModule(); // or let RunnerManager/EnvServer reload on the next fetch
```

Changed and removed keys are invalidated like `invalidateModule()` does, together with the modules importing them, so the next `reloadModule()` sees the new map:

- An **added** key resolves from then on, path keys included. An importer that failed to import it, or that loaded the real file it now overrides, picks it up once it is re-evaluated: the reloaded entry, virtual importers, and on Node.js and Deno also real files between them. A runner started without `data.virtual` registers its virtual modules on the first update, and real files it loaded before aren't tracked as importers.
- A **removed** key falls through to normal resolution: the real file it overrode, or a "not found" error. On Bun, a removed key without a file extension (see the Bun notes above) fails to load instead of falling through, and on miniflare an unresolvable bare specifier gets an empty module, as usual there.

Calls are applied one at a time in call order (a later call never loses to a slower factory of an earlier one), and `reloadModule()` waits for pending ones. A call made before the runner is ready waits for it. `invalidateModule(specifier)` is the same as updating the key with its current source. The runner keeps its own copy of the map, never changing your `data.virtual`. `RunnerManager.updateVirtualModules()` marks the manager dirty like `invalidateModule()`, and `EnvServer` also keeps the changes for the runners it creates later (`reload()`, watch mode). Changes made before the server started are only recorded, and the first runner starts with them.

Each module has a **format**. By default it follows the key's extension, like Node.js does for files: `.cjs` is CommonJS, `.ts`/`.mts` TypeScript, `.cts` CommonJS TypeScript, `.json` JSON, `.jsx`/`.tsx` JSX and `.wasm` WebAssembly. Any other string is an ES module, and any other `Uint8Array` raw bytes. To set the format explicitly, for example on a key without an extension, pass `{ source, format }`:

```ts
import { readFileSync } from "node:fs";

await using runner = new NodeWorkerEnvRunner({
  name: "my-app",
  data: {
    entry: "#entry.ts",
    virtual: {
      "#entry.ts": `
        import { getGreeting } from "#util.ts";
        import config from "#config";
        import legacy from "#legacy.cjs";
        import logo from "#logo";
        import add from "#add.wasm";
        const { exports } = await WebAssembly.instantiate(add);
        const handler: () => Response = () =>
          new Response(\`\${getGreeting(config.name)} \${legacy.answer} \${logo.length} \${exports.add(1, 2)}\`);
        export default { fetch: handler };
      `,
      "#util.ts": `export function getGreeting(name: string): string {
        return \`Hello, \${name}!\`;
      }`,
      "#config": { source: JSON.stringify({ name: "virtual" }), format: "json" },
      "#legacy.cjs": `module.exports = { answer: 42 };`,
      "#logo": readFileSync("logo.png"), // a Uint8Array: `bytes`
      "#add.wasm": readFileSync("add.wasm"),
    },
  },
});
```

| Format                | Default for                | Source       | Importing it gives                                |
| --------------------- | -------------------------- | ------------ | ------------------------------------------------- |
| `module`              | other string sources       | string       | the ES module                                     |
| `commonjs`            | `.cjs`                     | string       | `module.exports` as default export, named exports |
| `module-typescript`   | `.ts`, `.mts`              | string       | the ES module, types stripped                     |
| `commonjs-typescript` | `.cts`                     | string       | like `commonjs`, types stripped                   |
| `json`                | `.json`                    | string       | the parsed value as default export                |
| `jsx`, `tsx`          | `.jsx`, `.tsx`             | string       | the ES module (Bun only)                          |
| `text`                | —                          | string       | the string as default export                      |
| `bytes`               | other `Uint8Array` sources | `Uint8Array` | a `Uint8Array` as default export                  |
| `wasm`                | `.wasm`                    | `Uint8Array` | a compiled `WebAssembly.Module` as default export |

The code formats are named like Node's [load formats](https://nodejs.org/api/module.html#loadurl-context-nextload), and `text` and `bytes` like the `with { type }` import attributes proposed for them (import them without attributes, though). An unknown format, or a source that doesn't fit its format (a `Uint8Array` for `json`, a string for `wasm`, bytes that aren't valid WebAssembly), closes the runner at startup with an error naming the key, or rejects `updateVirtualModules()` before anything changes.

- **TypeScript** is type-stripped by Node's native [type stripping](https://nodejs.org/api/typescript.html#type-stripping) (Node.js >= 22.18 / 23.6 — erasable syntax only) and by Bun's `ts` loader. On Deno, custom load hooks bypass its native type stripping, so sources are pre-stripped with [`module.stripTypeScriptTypes`](https://docs.deno.com/api/node/module/~/Module.stripTypeScriptTypes) (Deno >= 2.8.2); on older Deno without it, virtual TypeScript sources **throw at registration** — pass pre-transpiled JavaScript instead. On miniflare, sources are likewise pre-stripped with `module.stripTypeScriptTypes` on the host (workerd does not parse TypeScript).
- **JSON** sources expose the parsed value as the default export on all runtimes. The `with { type: "json" }` import attribute is optional on Node.js and Bun; on Deno and miniflare it must be **omitted** (static imports carrying an import attribute bypass `registerHooks` resolution on Deno, and workerd rejects import attributes outright).
- **CommonJS** is loaded natively by Node.js and workerd (miniflare). Bun and Deno only parse in-memory sources as ES modules, so there the source runs inside an ES module wrapper, as strict-mode code. Named exports are detected like Node.js does ([cjs-module-lexer](https://github.com/nodejs/cjs-module-lexer)), but re-exports (`module.exports = require("./other.cjs")`) only add named exports on Node.js. `require()` resolves packages, real files and other virtual modules, with these exceptions:
  - On Deno, `require()` only reaches real files and packages, not virtual modules (Deno reads required files from disk), and requiring an ES module crashes Deno 2.9 while module hooks are registered (a Deno bug).
  - On miniflare, a virtual module that is `require()`d keeps its first instance when it changes (`invalidateModule()`, updates): only `import` specifiers are rewritten. Import it instead, or restart the runner.
  - On Node.js, after a module re-exported by CommonJS (`module.exports = require("./dep.cjs")`) changes, Node reads it as an empty, circular module (this happens with real files too after deleting them from `require.cache`). Assign it first (`const dep = require("./dep.cjs"); module.exports = dep;`).
- **Text and bytes** can't be imported from memory natively on every runtime, so they are served as ES modules where needed. `bytes` gives each module instance its own `Uint8Array`. Bytes survive every transport, including the process runners' JSON IPC (as base64) and `updateVirtualModules()`.
- **WebAssembly** default-exports a compiled [`WebAssembly.Module`](https://developer.mozilla.org/docs/WebAssembly/Reference/JavaScript_interface/Module) on every runtime, so instantiate it yourself with `WebAssembly.instantiate(module, imports)`. This follows workerd, which compiles `.wasm` modules ahead of time and disallows compiling Wasm at runtime. Node.js and Deno's own `.wasm` imports instantiate the module instead ([Wasm ESM integration](https://github.com/WebAssembly/esm-integration)), and Bun's give a file path, so those aren't used.
- **JSX** is only supported on Bun, by its `jsx`/`tsx` loaders (configure the JSX runtime with `tsconfig.json` or pragma comments like `/** @jsxImportSource preact */`). Node.js, Deno and miniflare can't load JSX from memory and fail with an error naming the key: pre-transpile it to JavaScript, and pass `{ source, format: "module" }` to keep a `.jsx`/`.tsx` key, or compile it with [plugins](#plugins-plugins).

Virtual modules are registered inside the worker, before the entry is imported. On Node.js (>= 22.15 / 23.5) and Deno (>= 2.8) this uses [ESM customization hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) (`module.registerHooks`); on Bun (which does not implement `registerHooks`) it uses a [`Bun.plugin()`](https://bun.com/docs/runtime/plugins) runtime plugin instead, also for the Node.js runners when the host runtime is Bun. Each source is served in its format, and virtual specifiers (including a virtual entry) resolve across `reloadModule()`. On runtimes supporting neither mechanism, a warning is logged and registration is skipped. When the worker shuts down gracefully the registration is unregistered again (the `registerHooks` registration is deregistered; on Bun, which has no plugin-removal API, the registration is detached so fresh loads and reloads stop resolving, and an overridden real file loads from disk again).

On `MiniflareEnvRunner` there is no in-worker registration: the runner's module fallback service serves virtual specifiers to workerd directly (taking precedence over disk files and the `transformRequest` pipeline, so a virtual key overrides a real file with the same path). Named `exports` (Durable Objects / WorkerEntrypoints / Workflows) also work with virtual entries.

#### Plugins (`plugins`)

Pass the `plugins` runner option to resolve, load and transform the entry, its imports and virtual modules with **plugins that run on the host**. While resolving an import or loading a module, the worker sends it to the runner, the runner runs the plugins' `resolveId`, `load` and `transform` handlers and sends the result back, and the worker uses that result. Plugins are plain objects in the host process, so handlers can be async, close over host state and share work with the rest of your tooling. It works on every runner except `SelfEnvRunner`, which closes with an error (an empty list, or plugins without these hooks, count as no `plugins`). `loadRunner()` and `EnvServer` take the same `plugins` option (`EnvServer` passes it to every runner it creates).

> The runner `plugins` option is unrelated to the srvx server `plugins` of your [app entry](#app-entry): those stay on the entry's default export.

TypeScript enums, namespaces and JSX need a compiler. A plugin with [`oxc-transform`](https://oxc.rs/docs/guide/usage/transformer) (`npm i -D oxc-transform`) covers them:

```js
import { transformSync } from "oxc-transform";
import { NodeProcessEnvRunner } from "env-runner/runners/node-process";

const oxc = {
  name: "oxc",
  transform: {
    filter: { moduleType: ["ts", "tsx", "jsx"], id: { exclude: "**/generated/**" } },
    handler(code, id, { moduleType }) {
      const result = transformSync(id, code, { sourcemap: true, lang: moduleType });
      // `errors` also holds warnings: only fail on errors.
      const errors = result.errors.filter((error) => error.severity === "Error");
      if (errors.length > 0) this.error(errors.map((error) => error.message).join("\n"));
      return { code: result.code, map: result.map, moduleType: "js" };
    },
  },
};

const version = {
  name: "version",
  transform: {
    order: "pre", // "pre" | "post" (default: unordered)
    filter: { id: "src/**", moduleType: ["ts", "tsx"], code: "__VERSION__" },
    async handler(code) {
      // Any async work on the host (`readVersion()` is your own).
      return code.replaceAll("__VERSION__", JSON.stringify(await readVersion()));
    },
  },
};

const runner = new NodeProcessEnvRunner({
  name: "my-app",
  plugins: [oxc, version],
  data: { entry: "./src/server.tsx" },
});
```

`transform` can also be a plain function. Handlers get `(code, id, { moduleType })` and return a string, `{ code, map, moduleType }`, or nothing to keep the code (`moduleSideEffects` and `meta` in a result are ignored). Nested arrays in `plugins` are flattened and falsy entries skipped, so a plugin can be added conditionally (`isDev && plugin`).

In every handler, `this` has:

- `this.warn(message)` and `this.info(message)` log, and `this.error(message)` throws, all prefixed with the plugin name and module id. `message` can also be a log object, `{ message, loc?, pos?, frame? }`. A position (a second argument, else the log's `loc` `{ line, column }` or `pos` offset) is appended to the id as `:line:column`, and a `frame` goes below the message. `this.debug()` is ignored.
- `this.resolve(source, importer?, { skipSelf?, isEntry?, attributes? })` resolves an import on the host as the runner would. It runs the `resolveId` hooks, then Node.js ESM resolution from `importer` (or the working directory) with the runner's export conditions, then the `fallback` hooks (below). It returns `{ id, external }`, with builtins (`node:fs`) as external, or `null` when nothing resolves it; like Node.js, it tries no extensions or directory indexes. Called from a `resolveId` handler, it skips that plugin's own hook (`skipSelf: false` keeps it), also when another plugin asks again for the same source and importer.
- `this.addWatchFile()` is accepted and ignored (`this.getWatchFiles()` is empty), and `this.meta.watchMode` is `false`.

Errors a handler throws are reported the same way, with the plugin name and module id, and a `loc`/`pos` and `frame` of the error: `[env-runner] plugin "version" failed on "/app/src/index.ts:3:10": ...`. Positions are in the code the hook got (after earlier hooks changed it). Other hooks (`buildStart`, `renderChunk`, ...) are ignored, and handlers find no other context methods (`this.emitFile`, `this.parse`, ...): calling one fails with a `TypeError`.

**Resolving and loading modules:** `resolveId` and `load` hooks serve modules that aren't files, redirect imports, or load files the runtime can't:

```js
const virtual = {
  name: "virtual",
  resolveId: {
    filter: { id: /^virtual:/ },
    handler(source, importer) {
      // `\0` marks an id that isn't a file.
      if (source === "virtual:routes") return "\0virtual:routes";
    },
  },
  load: {
    filter: { id: /^\0virtual:/ },
    async handler(id) {
      if (id === "\0virtual:routes") return `export default ${JSON.stringify(await scanRoutes())};`;
    },
  },
};

const alias = {
  name: "alias",
  resolveId: {
    filter: { id: "@/**" },
    handler: (source) => resolve("src", source.slice(2)), // an absolute path loads that file
  },
};

const yaml = {
  name: "yaml",
  transform: {
    filter: { id: /\.ya?ml$/ },
    handler: (code) => `export default ${JSON.stringify(parseYAML(code))};`,
  },
};

// `import svg from "./logo.svg?raw"`: the file's text as the default export.
const raw = {
  name: "raw",
  load: {
    filter: [{ kind: "include", expr: { kind: "query", key: "raw", pattern: true } }],
    handler(id) {
      const code = readFileSync(id.slice(0, id.indexOf("?")), "utf8");
      return { code: `export default ${JSON.stringify(code)};`, moduleType: "js" };
    },
  },
};
```

- `resolveId(source, importer, { isEntry, attributes })` runs for the imports its filter matches, with the specifier as written, query included (`file:` URLs as paths). `importer` is the importing module's id (a path with its query, or an id a `resolveId` hook returned), and `undefined` for the entry. The first handler returning a result wins. Returning nothing leaves the import to the next plugin, then to the runtime.
- A resolved absolute path (a query is kept) loads that file, through `load` hooks and then from disk. A path that is a key of `data.virtual` loads that virtual module, also without a file on disk. Any other id, like `\0virtual:routes`, must be returned by a `load` hook, and relative imports inside such a module resolve from the working directory.
- **`fallback: true`** makes a `resolveId` hook run only for imports the runtime fails to resolve, after the runtime tried. The worker tries first, so imports it resolves take no round trip, unlike other `resolveId` hooks, which run before the runtime for every import their filter matches. Use it for imports the runtime can't resolve itself, like extensionless relative imports (`./utils`), which Bun resolves itself:

  ```js
  const extensionless = {
    name: "extensionless",
    resolveId: {
      fallback: true,
      filter: { id: /^\.\.?\// },
      handler: (source, importer) =>
        [".ts", ".mts", "/index.ts"]
          .map((ext) => join(dirname(importer), source + ext))
          .find((path) => existsSync(path)),
    },
  };
  ```

`false` or `{ id, external: true }` leaves the import (or the returned id) to the runtime. Only Node.js and Deno import a different non-path id returned with `external`; Bun and miniflare keep the original specifier, so return an unchanged id or a path for portable externals.

- `load(id)` returns the module's code, or `{ code, map, moduleType }`. The first handler returning code wins, and `transform` hooks run on the result. Without a `moduleType`, it is the id's type (`js` for other extensions). When no `load` hook returns code, the file is read from disk (without the id's query).
- **Queries:** ids keep the import's query (`/app/logo.svg?raw`), in `load`, `transform` and filters, and the query is part of the module's identity: `./dep.ts` and `./dep.ts?raw` are separate modules on every runner. The module type comes from the path (`svg` there). Query params env-runner adds itself (reload cache-busting, virtual module versions, Bun and miniflare markers) are removed from the ids plugins see, and the import's own params are kept as written.
- `resolveId` and `load` filters take only `id` (or filter expressions without `code` and `moduleType`). For `resolveId`, `id` matches the specifier with its query, and globs aren't resolved from the working directory (`virtual:*`, `@/**`).
- Error messages name the hook: `[env-runner] plugin "virtual" failed to load "\0virtual:routes": ...`.
- **`.wasm`**: a `load` hook (an `id` filter like `/\.wasm$/` names the type) returns an ES module wrapper around the file. On Node.js, Deno and Bun it can inline the bytes and compile them. workerd can't compile bytes at runtime, so on miniflare the wrapper imports the file as a compiled module (with a query the hook's filter leaves out, served by the runner as a WebAssembly module) and instantiates it:

  ```js
  const wasm = (workerd = false) => ({
    name: "wasm",
    load: {
      filter: { id: /\.wasm$/ },
      handler(id) {
        const bytes = readFileSync(id);
        const names = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
        return [
          workerd
            ? `import module from ${JSON.stringify(`${id}?module`)};`
            : `const module = new WebAssembly.Module(Uint8Array.from(atob("${bytes.toString("base64")}"), (c) => c.charCodeAt(0)));`,
          "const { exports } = new WebAssembly.Instance(module);",
          ...names.map((name) => `export const ${name} = exports.${name};`),
        ].join("\n");
      },
    },
  });
  ```

**Which modules are sent:**

- Candidates are files outside `/node_modules/`, modules a `resolveId` hook resolved, and virtual modules with a code format.
- Files under `/node_modules/` only go to hooks with a matching `id` include that names `node_modules` (like `**/node_modules/my-pkg/**`, or an include filter expression with such an `id`), or to every matching hook when a `resolveId` hook returned their path.
- The worker gets each `load` and `transform` hook's `id` and `moduleType` filters (or its filter expressions). It only sends a candidate that one of them may match. A hook without these filters matches every script. The code isn't known in the worker, so `code` filters are checked on the host. Anything else loads without a round trip, so **give every plugin a `moduleType` filter, and an `id` filter where you can**.
- Scripts (module types `js`, `jsx`, `ts`, `tsx`) go to every hook whose filter matches. Other files only go to hooks whose filter names them:
  - an `id` include that matches (like `/\.ya?ml$/`, or `src/**`), or, in filter expressions, an include that matches through an `id` (or a present `query` param), not only through `code` or `not`;
  - for `.json`, `.node` and `.wasm`, which runtimes load themselves, a `moduleType` filter listing the type (`["json"]`, or a `moduleType` expression in the matching include) or a `load` hook's `id` include.
- Only imports that some `resolveId` filter matches are sent, so give `resolveId` hooks an `id` filter: without one, every import goes to the runner. Imports matching only `fallback` hooks' filters are sent only when the runtime fails to resolve them.
- On the host, each handler runs only when its whole filter matches the current code.

**Filters**: all given properties must match, and empty ones (`""`, `null`, `[]`) are ignored. Ids are matched with their path `/`-separated and **with their query string**, by globs and RegExps alike: `**/*.svg` and `/\.svg$/` don't match `/app/logo.svg?raw`, while `/\.svg(\?.*)?$/` and `**/*.svg{?*,}` match it with or without a query. A `query` filter expression (below) matches the params.

- `id`: RegExps are tested, strings are globs: `*` (within a path segment), `?`, `**` (any number of segments, so `src/**` matches below `src/`), `[abc]`, `[a-z]`, `[!abc]`, `{a,b}` (also nested) and `\` escapes. Globs are case-sensitive, have no extglobs, and `*`/`**` also match dot files and directories (`**/*.ts` includes `.nitro/`). Globs not starting with `**` and not absolute are resolved from the working directory when the runner is created (`src/**`, `*.ts`); characters like `[` or `{` in that directory match literally. On Windows, an absolute glob written with `\` separators only (`C:\app\*.ts`) treats them as separators, so use `/` to escape characters there.
- `code`: strings are substrings, RegExps are tested.
- `moduleType`: a non-empty list, or `{ include }`. It starts as the module's language: `js`, `jsx`, `ts`, `tsx` or `json` from the extension (or a virtual module's format), and the extension itself for other files (`vue`, `yaml`).
- Values can be arrays or `{ include, exclude }`, and exclude wins. RegExp `g`/`y` flags are ignored (every test matches anywhere in the value).
- Invalid values (a pattern that is neither a string nor a RegExp, an empty `moduleType` list) throw a `TypeError` when the runner is created.

`filter` can also be a list of **filter expressions**, objects with a `kind`:

```js
const filter = [
  { kind: "exclude", expr: { kind: "id", pattern: "**/vendor/**" } },
  {
    kind: "include",
    expr: {
      kind: "and",
      args: [
        { kind: "moduleType", pattern: "ts" },
        { kind: "not", expr: { kind: "code", pattern: /@generated/ } },
      ],
    },
  },
];
```

- The list holds `include` and `exclude` entries, and the first one whose `expr` matches decides. If none matches, the module matches only when there are no `include` entries.
- `expr` combines `and` / `or` (`args`) and `not` (`expr`) over `id`, `code` and `moduleType` (`pattern`), matched like the properties above.
- `query` (`key`, `pattern`) matches the id's query, parsed with `URLSearchParams` (decoded, without a `#` fragment): `pattern: true` matches when `key` is present (`?raw`, `?raw=0`), `false` when it's absent, a string equals its value (`""` for `?raw`), and a RegExp tests it (`""` when absent). `importerId` is rejected.
- The worker sends a module unless its expressions can't match whatever the code is.

**Rules:**

- **Order:** `pre` handlers, then unordered ones, then `post` ones. Within each group, plugins are sorted by their `enforce` (`"pre"` plugins first, `"post"` last), then `plugins` order is kept, so list a compiling plugin before plugins that expect JavaScript.
- **Output:** a compiling handler returns `moduleType: "js"`, and later handlers see it. If no handler changed a module, it loads as if unmatched. Output still typed as `ts` is left to the runtime's type stripping, like an untransformed file (on miniflare, the host strips it), so a code-only plugin doesn't need a compiler before it. Output still typed as `jsx`/`tsx` fails to load.
- **Other file types:** a handler that turns another file type (`yaml`) into code without returning a `moduleType` makes it `js`. JSON stays JSON while it parses as JSON, and is served as a JSON module: with `with { type: "json" }` (or `require()`) where the runtime expects one, else as an ES module with the value as default export and its top-level keys as named exports.
- **Source maps are not composed:** the first returned `map` is appended inline, and a second one drops both (with a warning, once per pair of plugins). Code-only results keep the current map, so keep such changes line-preserving.
- **Errors** from a handler fail the import of that module in the worker, as the error message (with its position and frame). At startup, the runner closes with it as the cause (`waitForReady()` rejects, and `RunnerManager.onClose()` listeners get it). On `reloadModule()`, the reload rejects with it and the previous entry keeps serving. On miniflare, a named import of the failing module can fail to link first, so the error is also logged on the host.
- **Order with virtual modules and other hooks:** virtual modules come first. An import of a `data.virtual` key never reaches `resolveId` hooks (virtual modules are transformed on the host before they are sent), and a path a `resolveId` hook returns that is a virtual key loads that virtual module. On Node.js and Deno, a `module.registerHooks()` call in the entry registers hooks that run before env-runner's, for imports after it (hooks registered later run first; their `nextResolve()`/`nextLoad()` reach env-runner's). On Bun, env-runner's callbacks run before those of a `Bun.plugin()` in the entry, which only get what env-runner's leave. On miniflare, the order is virtual modules, `resolveId` hooks, resolution on the host, `fallback` hooks, `transformRequest`, then `load` and `transform` hooks.
- **Cost:** each module sent is one blocking round trip. Measured on an app of 400 small modules (Node.js 24, Bun 1.4, Deno 2.9, one desktop machine): about 50 µs per module with `NodeWorkerEnvRunner`, and 150 to 330 µs per module with the process runners, which also pay a fixed 10 to 30 ms at startup. A `resolveId` hook costs about the same per import it matches. A plugin whose filters match no module still runs the load hook for every module: about 20 µs per module with `NodeWorkerEnvRunner`, 50 µs on Bun and 115 µs on Deno. Nothing is cached on the host: `reloadModule()` sends only the entry again, since the runtime keeps its imports cached.
- **Don't wait on the same runner** in a handler (`runner.fetch()`, `rpc()`, ...): its worker is blocked until the handler returns. A transform taking over 10 seconds logs a warning in the worker.

How it works:

- **Transport:** module loader hooks are synchronous, so the worker blocks until the runner replies. `NodeWorkerEnvRunner` (and the Vercel and Netlify runners) pass the worker a `MessagePort`. The process runners listen on a local socket (a unix socket in a private temporary directory, or a named pipe on Windows), which a helper thread in the worker connects to. CI runs the `NodeProcessEnvRunner` plugin tests on Windows, over the named pipe; Bun and Deno plugins on Windows are untested. If the runner goes away, a pending load throws instead of hanging.
- **Node.js** and **Deno**: a `module.registerHooks` load hook. The output is ESM or CommonJS: by the package `"type"` when Node.js reports it, else `.mts`/`.cts`, else CommonJS only for output with CommonJS markers (`require()`, `module.exports`) and no ESM syntax. Deno evaluates hook output as plain ESM, so it gets TypeScript stripped and CommonJS wrapped as an ES module. Deno reads `require()`d files from disk, untransformed, and untouched CommonJS files load natively (CommonJS `.ts`/`.js` there needs `--unstable-detect-cjs` in the runner's `execArgv`). With that flag, Deno skips load hooks for `.ts` files in packages without `"type": "module"`, so plugins don't see them: add `"type": "module"` to that `package.json`, or use `.mts`.
- **Node.js** and **Deno** resolve imports with a `module.registerHooks` resolve hook, which sees every import. `fallback` hooks get an import when the default resolution throws, or (Deno) resolves to a path without a file.
- **Bun**: a `Bun.plugin()` `onLoad` with one filter RegExp built from the plugins' `moduleType` filters (implied extensions) and `id` filters (globs match either path separator; on Windows, `id` RegExps are left to the per-module check), not from filter expressions. Bun evaluates plugin output as ESM and can't decline a load, so CommonJS is wrapped as an ES module, also in files the RegExp covers but no plugin matches. `.cjs`/`.cts` never reach it. Other file types are sent while their import is resolved, so a file no plugin changes still loads with Bun's own loader (`.txt`, `.toml`, a path for unknown extensions). Virtual modules are registered first, so a virtual key overriding a file wins, like on Node.js.
- **Bun imports** go through `onResolve`, which Bun only calls for some specifiers. Bare specifiers without an extension (`~icons/home`, `@/utils`) never reach it, while `@/utils.ts` does. A `scheme:rest` specifier only reaches the callbacks of its scheme, so the runner adds one for each scheme its `resolveId` filters start with (`/^virtual:/`, `"virtual:*"`). `onResolve` runs before Bun resolves, so for `fallback` hooks the runner asks `Bun.resolveSync()` first.
- **Miniflare**: no worker round trip. Imports workerd can't resolve itself, and disk modules, go through the plugins in the module fallback service. Modules that `transformRequest` returns code for are served as is. A plugin error is logged on the host and thrown from the failing module. A persistent instance runs the plugins of the runner currently using it. A `resolveId` result that is a virtual path key is redirected to that key, and `.wasm` files no plugin loads are served as WebAssembly modules.
- **Virtual modules** are transformed on the host before they are sent, also on `updateVirtualModules()`/`invalidateModule()` (a source that fails to transform rejects the update and changes nothing). This makes JSX work on every runner (e.g. `#entry.tsx`, or `{ source, format: "tsx" }`). The output stays in its format's module system.
- `reloadModule()` sends the entry again; already-imported modules stay cached.

#### Miniflare Runner

Run your app in the Cloudflare Workers runtime using [miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare).

`env-runner` declares no peer dependencies — install `miniflare` (v4 or v5) yourself and pass it to the runner (see [Runtime dependencies](#runtime-dependencies)):

```bash
npm install miniflare
```

```ts
import * as miniflare from "miniflare";
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  miniflareOptions: {
    compatibilityDate: "2024-01-01",
    kvNamespaces: ["MY_KV"],
  },
});

const response = await runner.fetch("http://localhost/api");
// Request inputs also preserve methods, headers, streaming bodies and cancellation.
// An optional RequestInit overrides the corresponding Request properties.
```

Passing `miniflare` explicitly is preferred — the version you install is then the version that runs. A specifier works too (`miniflare: "miniflare"`). If you omit it, the runner imports `miniflare` itself and only fails (with an actionable error) when the package isn't installed either. The `miniflareOptions` object is passed directly to the [Miniflare constructor](https://developers.cloudflare.com/workers/testing/miniflare/) — you can configure bindings, KV, D1, Durable Objects, and any other Miniflare option.

The entry uses the same `AppEntry` format as the other runners, plus an optional `resolveExports()` hook (see [Worker exports](#worker-exports)). Requests are handled like srvx's Cloudflare adapter (`srvx/cloudflare`): the entry's `plugins`, `middleware` and `error` handler are applied, and the request carries `request.runtime` (`{ name: "cloudflare", cloudflare: { env, context } }`), `request.ip` (from `cf-connecting-ip`) and `request.waitUntil()`. For Workers-style entries, `fetch` still receives `(request, env, ctx)`. env-runner's internal bindings are never exposed on `env`. Listener-level srvx options (`maxRequestBodySize`, `trustProxy`, `node`/`bun`/`deno`, ...) do not apply to miniflare.

When you don't set a compatibility date, it defaults to the date supported by the installed `workerd` binary rather than today's date — the binary always lags the calendar slightly, and pinning a future date makes `workerd` refuse to start. Set the runner's `compatibilityDate` option to pin one, or to `"latest"` to use the installed `workerd`'s supported date explicitly (no need to import `miniflare` for `supportedCompatibilityDate`). Precedence: `miniflareOptions.compatibilityDate` > `compatibilityDate` > the wrangler config's `compatibility_date` > the supported date. Whatever the source, a date newer than the installed `workerd` supports falls back to the supported date with a warning (like `wrangler dev`).

The runner enables the `nodejs_compat` compatibility flag by default. Set `no_nodejs_compat` (in the wrangler config's `compatibility_flags` or in `miniflareOptions.compatibilityFlags`) to opt out; the generated wrapper then avoids Node.js built-ins. If the two sources disagree, `miniflareOptions` wins.

#### Wrangler Config

Set the `wrangler` option to load a Cloudflare [Wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) (`wrangler.json` / `wrangler.jsonc` / `wrangler.toml`) into the Miniflare options — compatibility date/flags and bindings (`vars`, KV, R2, D1, Durable Objects, queues):

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  wrangler: true, // auto-discover wrangler.{json,jsonc,toml} (see below)
  // wrangler: "./config/wrangler.toml", // or an explicit path
  // wranglerEnv: "production",          // select a `[env.production]` block
  // compatibilityDate: "latest",        // override the config's compatibility_date
});
```

Auto-discovery searches parent directories: when the entry file is inside the current working directory, it walks up from the entry's directory to the filesystem root (so a config at a monorepo root is found for an entry in `apps/web/src/`); when the entry lives elsewhere (e.g. a framework entry hoisted under `node_modules/.pnpm`), only the entry's own directory is checked before walking up from the cwd, so the cwd's config is never shadowed by one above the entry. The nearest directory wins; within one directory `wrangler.json` is preferred over `wrangler.jsonc`, then `wrangler.toml` (unlike `wrangler`, which looks for each filename all the way up before trying the next). A config found in a parent directory is logged once.

`wranglerEnv` selects a named Wrangler environment (`--env`). When omitted, it defaults to the `CLOUDFLARE_ENV` environment variable, so `CLOUDFLARE_ENV=production` selects the `production` env without passing the option.

You can also pass an **inline** config object (raw `wrangler.json` shape) instead of (or in addition to) a file — handy for programmatic setups:

```ts
await using runner = new MiniflareEnvRunner({
  miniflare,
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

When an inline config is passed, a `wrangler.{json,jsonc,toml}` file is still auto-discovered (as above) and loaded, and the inline config is **merged on top of it** — inline values win per key, binding records (e.g. `vars`) merge, and `compatibilityFlags` are unioned. This lets you keep a committed `wrangler` file and override a few fields programmatically. If the inline config doesn't define the selected `wranglerEnv`, its top level is used as-is (the file's env still applies), and a config that fails to load only warns without discarding the other one.

Set `wranglerConfigPath` to load a specific config file instead of auto-discovering one — with `wrangler: true` or an inline config (which still merges on top), and without changing the working directory:

```ts
await using runner = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./.nitro/dev/index.mjs" },
  wrangler: { vars: { GREETING: "hello" } },
  wranglerConfigPath: "./wrangler.jsonc", // relative to cwd
});
```

A missing `wranglerConfigPath` file warns (an inline config is still applied). When `wrangler` is itself a string path, that path wins and `wranglerConfigPath` is ignored.

The runner hosts a single worker, so config entries it can't run are **dropped**: `assets`, `services`, `queues.consumers`, `tail_consumers`/`streaming_tail_consumers`, and Durable Object and Workflow bindings to another script (`script_name`). Durable Object and Workflow bindings to local classes (exported by your entry or an [exports module](#exports-module)) are kept — including bindings whose `script_name` is the worker's own `name` (the inline config's `name` when set, else the file's; with `wranglerEnv` suffixed `-<env>` unless the env section sets a `name`, e.g. `my-worker-staging`), which are local in `wrangler dev` too — and merged with [auto-detected exports](#auto-detected-exports). Pass any of the dropped options via `miniflareOptions` to opt back in.

Whenever `wrangler` is enabled (`true`, a path, or an inline config), local state (KV, D1, R2, Durable Objects, ...) persists under `<dir>/.wrangler/state/v3` — the same place `wrangler dev` uses, so both share data. `<dir>` is the directory of the loaded config file, else of the requested config path (`wrangler` string or `wranglerConfigPath`, even if the file is missing), else the current working directory (e.g. inline-only configs, or `wrangler: true` with no file found). Set `miniflareOptions.defaultPersistRoot` (or any `*Persist` option, e.g. `kvPersist: false`; on miniflare v5, `resourcePersistencePath`) to opt out.

Pass the [`wrangler`](https://www.npmjs.com/package/wrangler) package as `wranglerModule` — the imported module or a specifier — for full fidelity: TOML, config validation, and every binding type.

```ts
import * as miniflare from "miniflare";
import * as wrangler from "wrangler";

await using runner = new MiniflareEnvRunner({
  miniflare,
  wranglerModule: wrangler,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  wrangler: true,
});
```

With the `wrangler` package, wrangler's own config warnings (e.g. unexpected/misspelled keys, or a `wranglerEnv` the config doesn't define) are printed for a config file — once per file version and env, so hot reloads don't repeat them. Inline configs are validated without printing wrangler's warnings (load errors still warn). As in `wrangler dev`, unexpected keys also trigger wrangler's npm update check (cached for a day), which may print a "newer version of Wrangler available" hint.

Set `wranglerEnvFiles` to load local dev vars/secrets from custom `.env` files, like `getPlatformProxy({ envFiles })`:

```ts
await using runner = new MiniflareEnvRunner({
  miniflare,
  wranglerModule: wrangler,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  wrangler: true,
  wranglerEnvFiles: [".env", ".env.development"], // relative to the config file's dir
});
```

Paths resolve against the loaded config file's directory (else the current working directory) and later files override earlier ones. When set (non-empty), `.dev.vars` is not read; when unset, wrangler's defaults apply (`.dev.vars[.<env>]`, else `.env*`); an empty array reads `.dev.vars` but no `.env*` files. Both the `wrangler` package and the built-in minimal reader honor it.

Without `wranglerModule`, `wrangler` is imported optionally; if that fails too, a built-in minimal reader handles JSON/JSONC files and inline objects (TOML files are skipped with a warning). It follows wrangler's semantics for `env` selection (bindings and `vars` are not inherited into a named env), local ids (`preview_id` / `preview_bucket_name` / `preview_database_id` first, so state is shared with `wrangler dev`), SQLite-backed Durable Objects (`migrations[].new_sqlite_classes`) and dev vars (`.dev.vars[.<env>]`, `.env*`, `secrets.required`), but only maps common bindings (`vars`, KV, R2, D1, Durable Objects, Workflows, queue producers); other bindings (e.g. `hyperdrive`, `ai`, `ratelimits`) are ignored with a warning. Pass `wranglerModule: false` to always use the minimal reader. Values you pass in `miniflareOptions` always take precedence over config-derived ones — binding records (e.g. `bindings`) merge per key, and `compatibilityFlags` are merged.

Config options a single dev worker can't run — `services`, `assets`, `queues.consumers`, `tail_consumers`/`streaming_tail_consumers`, and `durable_objects`/`workflows` bindings with a `script_name` naming another worker — are ignored with one warning listing them (e.g. `services (MY_SERVICE)`); pass the equivalent Miniflare options via `miniflareOptions` to opt in.

#### Module Transform Pipeline

Pass a `transformRequest` callback to route module resolution through Vite's (or any) transform pipeline. This enables TS, JSX, and other non-JS formats to be compiled on-the-fly inside the Workers runtime without pre-bundling:

```ts
import { MiniflareEnvRunner } from "env-runner/runners/miniflare";

await using runner = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  // Route module resolution through Vite's transform pipeline
  transformRequest: (id) => viteDevEnvironment.transformRequest(id),
});
```

When `transformRequest` is provided:

- The `unsafeModuleFallbackService` calls it with the resolved file path before falling back to raw disk reads
- Module rules for `.ts`, `.tsx`, `.jsx`, and `.mts` are added automatically
- The wrapper never statically re-exports the entry (`export *`), to avoid miniflare's ModuleLocator pre-walking its import tree

The callback should return `{ code: string }` for transformed modules, or `null`/`undefined` to fall back to the default raw file read.

#### Worker Exports

Durable Object, `WorkerEntrypoint` and `WorkflowEntrypoint` classes declared in the config run from the current entry, so they share module state with requests and follow `reloadModule()`. A Durable Object is re-created with the new code and keeps its storage. Classes are declared by:

- local Durable Object bindings (`durable_objects` / `miniflareOptions.durableObjects`, also [auto-wired](#auto-detected-exports) ones) and SQLite/KV-backed classes from `migrations`
- local Workflows (`workflows` / `miniflareOptions.workflows`)
- the wrangler config's `exports` (`{ "Greeter": { "type": "worker" } }`, also `durable-object` and `workflow`)

```ts
// worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
export { Counter } from "./counter.ts"; // bound in wrangler.json
// Declared in wrangler.json: "exports": { "Greeter": { "type": "worker" } }
export class Greeter extends WorkerEntrypoint {
  greet(name: string) {
    return `hello ${name}`;
  }
}

export default {
  async fetch(request, env, ctx) {
    return new Response(await ctx.exports.Greeter.greet("world"));
  },
};
```

The classes are the entry's named exports, or come from its `resolveExports()` hook, called on each use (for entries that load the app themselves, e.g. through a module runner):

```ts
export default {
  fetch: (request) => app.fetch(request),
  resolveExports: () => import("./app/exports.ts"),
};
```

As with `@cloudflare/vite-plugin`, Durable Objects can't have RPC methods named `email`, `queue`, `scheduled`, `tail`, `tailStream`, `test` or `trace`, and `WorkerEntrypoint`s can't have ones named `alarm`, `webSocketClose`, `webSocketError` or `webSocketMessage`.

A warning after each load lists declared classes the entry doesn't export, and exported classes nothing declares.

#### Auto-detected Exports

`MiniflareEnvRunner` automatically scans the entry file for `export class` declarations and wires them as Durable Object bindings (binding name = class name in `SCREAMING_SNAKE_CASE`, e.g. `COUNTER`). `WorkerEntrypoint`/`WorkflowEntrypoint` classes aren't bound; declare them (see above) so they follow reloads. This means you don't need to manually configure `miniflareOptions.durableObjects` for simple cases:

```ts
// worker.ts
export class Counter {
  /* ... Durable Object implementation ... */
}

export default {
  async fetch(request, env) {
    // env.COUNTER is auto-wired — no manual config needed
    const id = env.COUNTER.idFromName("test");
    const stub = env.COUNTER.get(id);
    return stub.fetch(request);
  },
};
```

To explicitly declare exports or override auto-detection:

```ts
await using runner = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  // Explicit exports (merged with auto-detected ones)
  exports: { Counter: { type: "DurableObject" }, Greeter: { type: "WorkerEntrypoint" } },
});
```

Auto-wired bindings are merged with Durable Object bindings from `miniflareOptions` and a wrangler config: exports whose class is already bound (or whose binding name is taken) are skipped. Set `exports: false` to disable auto-detection entirely (declared classes still work).

#### Exports Module

To load named exports from a separate module, set `exports` to its absolute path or a `data.virtual` key (a relative path resolves from the entry's directory, not the working directory). The wrapper re-exports it with `export *`, so re-exports and exported aliases work.

In this mode nothing is stubbed, auto-detected or auto-wired: configure the bindings with `wrangler` or `miniflareOptions`. The entry's own `export class` declarations are **not** re-exported either, so re-export them from the exports module if they are bound.

```ts
const runner = new MiniflareEnvRunner({
  name: "app",
  miniflare,
  data: {
    entry: "/path/to/server.mjs",
    virtual: {
      "#server-exports": 'export { Counter } from "/path/to/counter.mjs";',
    },
  },
  exports: "#server-exports",
  miniflareOptions: { durableObjects: { COUNTER: "Counter" } },
});
```

An exports module loads when the worker starts: recreate the runner when its classes change (`reloadModule()` only reloads the request entry). In every mode the list of exports is fixed at startup, so recreate the runner when a class is added or removed.

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
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  persistent: true,
});

// Later, after close() + creating a new runner with the same config,
// the Miniflare instance is reused (faster startup)
await runner1.close();

const runner2 = new MiniflareEnvRunner({
  miniflare,
  name: "my-worker",
  data: { entry: "./worker.ts" },
  persistent: true,
});

// Fully destroy: runner.dispose() or MiniflareEnvRunner.disposeAll()
```

An instance is only reused by runners with the same virtual module sources. Once `invalidateModule()` or `updateVirtualModules()` changes them, the instance leaves the cache (runners attached to it keep using it), and later runners start a fresh one.

#### Vercel Runner

Simulates a Vercel deployment environment with automatic header injection (`x-vercel-deployment-url`, `x-vercel-forwarded-for`, forwarding headers) and global context.

```ts
import { VercelEnvRunner } from "env-runner/runners/vercel";

await using runner = new VercelEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
```

#### Vercel Queues (local delivery)

Framework integrations running inside the vercel runner can bind a topic to a handler for local delivery. Pass [`@vercel/queue`](https://www.npmjs.com/package/@vercel/queue) as `sdk` — the imported module or a specifier (omit it and the SDK is imported optionally; if it isn't installed, registration warns once and becomes a no-op so dev startup is never blocked):

```ts
import * as sdk from "@vercel/queue";
import { registerVercelQueueConsumer } from "env-runner/runners/vercel/queue-dev";

const unregister = await registerVercelQueueConsumer({
  sdk,
  topic: "orders",
  handler: (message, metadata) => dispatch(message, metadata),
  consumerGroup: "my-framework", // re-registering the same group replaces the handler (HMR-safe)
  retryAfterSeconds: 5, // or `retry: (error, metadata) => ({ acknowledge: true })`
});
```

One `QueueClient` is constructed per SDK instance and shared across registrations.

#### Netlify Runner

Simulates a Netlify deployment environment with automatic header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`, forwarding headers) and `globalThis.Netlify` setup:

```ts
import { NetlifyEnvRunner } from "env-runner/runners/netlify";

await using runner = new NetlifyEnvRunner({
  name: "my-app",
  data: { entry: "./app.ts" },
});
```

For the full compute runtime — `globalThis.Netlify` with context plus `globalThis.caches` — install [`@netlify/runtime`](https://www.npmjs.com/package/@netlify/runtime) and point the runner at it with `netlifyRuntime`:

```ts
await using runner = new NetlifyEnvRunner({
  name: "my-app",
  netlifyRuntime: import.meta.resolve("@netlify/runtime"),
  data: { entry: "./app.ts" },
});
```

The runtime has to start inside the worker thread, so this is the one runtime-dependency option that takes a module _specifier_ rather than an imported instance — a live module cannot cross that boundary. A bare specifier (`"@netlify/runtime"`) is resolved from the current working directory. If it cannot be imported, the runner warns and falls back to the shim, and `netlifyRuntime: false` forces the shim outright.

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
  miniflare,
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
  // Any other srvx ServerOptions are forwarded to serve() as-is, e.g.:
  error(error) {
    return new Response(error.message, { status: 500 });
  },
  maxRequestBodySize: 1024 * 1024,
  trustProxy: true,
  node: { keepAliveTimeout: 5000 },
  bun: { idleTimeout: 30 },
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

Every other [srvx `ServerOptions`](https://srvx.h3.dev/guide/options) key exported by the entry (`error`, `maxRequestBodySize`, `trustProxy`, `reusePort`, the runtime-specific `node` / `bun` / `deno` objects, ...) is forwarded to `serve()` unchanged, so one `server.ts` can carry the same options in dev and production. The listener options are owned by the worker, which sits behind the runner's proxy, and are ignored if set: `port`, `hostname`, `protocol`, `tls`, `silent`, `manual` and `gracefulShutdown` — as well as their equivalents nested in `node` (`port`, `host`, `path`, `cert`, `key`, `passphrase`, and `http2`, which srvx only supports with TLS), `bun` (`port`, `hostname`, `unix`, `tls`) and `deno` (`port`, `hostname`, `path`, `cert`, `key`). Custom workers can reuse the same logic via the exported `toServerOptions(entry)` helper.

For advanced use cases, you can provide a custom worker entry:

```ts
await using runner = new NodeProcessEnvRunner({
  name: "my-app",
  workerEntry: "/path/to/custom-worker.ts",
  data: { entry: "./app.ts" },
});
```

Process runners (`NodeProcessEnvRunner`, `BunProcessEnvRunner`, `DenoProcessEnvRunner`) deliver `data` over IPC, so its size (e.g. large virtual modules) is not bound by environment variable limits. A custom process worker requests it once its message listener is attached:

```ts
// custom-worker.ts
const data = await new Promise((resolve) => {
  const onMessage = (message) => {
    if (message?.event === "init-data") {
      process.off("message", onMessage);
      resolve(JSON.parse(message.data)); // `data` is sent as a JSON string
    }
  };
  process.on("message", onMessage);
  process.send({ event: "request-init-data" });
});
// ... start a server, then report it with `process.send({ address: { host, port } })`
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
