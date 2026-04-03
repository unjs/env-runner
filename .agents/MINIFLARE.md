# Miniflare Internals & Patterns

## Worker Script Modes

Miniflare accepts scripts in three mutually exclusive modes:

### Mode A — Explicit `modules` array (in-memory)

```ts
new Miniflare({
  modules: [{ type: "ESModule", path: "/virtual/worker.mjs", contents: "export default ..." }],
  modulesRoot: "/",
});
```

- `contents` is optional — falls back to `readFileSync(path)` if omitted
- Module **name** inside workerd = `path.relative(modulesRoot, def.path)`
- `modulesRoot` defaults to `process.cwd()`

### Mode B — Inline `script` string

```ts
new Miniflare({
  script: "export default { fetch() { return new Response('hi'); } }",
  scriptPath: "/path/to/virtual-entry.mjs", // for resolution + stack traces
  modules: true, // ESM mode (vs service worker mode)
});
```

- `scriptPath` determines the base directory for resolving relative imports
- The file at `scriptPath` is **never read** — it's purely a virtual path
- This is what env-runner uses

### Mode C — File on disk (`scriptPath` only)

```ts
new Miniflare({ scriptPath: "/path/to/worker.mjs", modules: true });
```

## `unsafeEvalBinding`

Exposes workerd's `UnsafeEval` API inside the worker via a named binding.

```ts
new Miniflare({ unsafeEvalBinding: "UNSAFE_EVAL" });
```

### Interface inside the worker

```ts
interface UnsafeEval {
  eval(code: string, name?: string): unknown;
  newFunction(script: string, name?: string, ...args: string[]): Function;
  newAsyncFunction(script: string, name?: string, ...args: string[]): Function;
}
```

- `eval()` — evaluate JS code, return result. `name` is optional filename for debugging
- `newFunction()` — like `new Function(...args, script)` but allowed inside workerd
- `newAsyncFunction()` — same but creates an async function

### Use cases

- **Dynamic module loading**: Create `import()` via `newAsyncFunction("return await import(path)", "loader", "path")` then call with a specifier
- **Hot-reload**: Re-import modules with cache-busting query strings (`?t=<version>`)
- **Code evaluation**: The vite plugin uses this to evaluate Vite-transformed module source inside workerd

### Limitations

- Cannot directly execute ES module syntax (`export`, `import` declarations) — only expressions/statements
- For ESM, must use dynamic `import()` or have Vite pre-transform to CJS-compatible code

## `unsafeModuleFallbackService`

A **shared (top-level)** option — a callback invoked when workerd can't resolve a module import.

```ts
new Miniflare({
  unsafeModuleFallbackService(request) {
    const url = new URL(request.url);
    const specifier = url.searchParams.get("specifier"); // absolute resolved path
    const rawSpecifier = url.searchParams.get("rawSpecifier"); // as written in source
    const referrer = url.searchParams.get("referrer"); // importing module
    const method = request.headers.get("X-Resolve-Method"); // "import" or "require"

    // Return module contents as JSON
    return Response.json({ name: "relative/path.mjs", esModule: "export default 42;" });
  },
  workers: [
    {
      unsafeUseModuleFallbackService: true, // per-worker opt-in
      // ...
    },
  ],
});
```

### Response format (`Worker_Module`)

```ts
{ name: string } & (
  | { esModule: string }       // ES module source
  | { commonJsModule: string } // CJS source
  | { text: string }           // plain text
  | { data: number[] }         // binary (Uint8Array as array)
  | { wasm: number[] }         // WebAssembly (Uint8Array as array)
  | { json: string }           // JSON module
)
```

- Return `404` → module not found (workerd falls back to built-in resolution for `node:`/`cloudflare:`)
- Return `301` with `Location` header → redirect to another module path
- `name` must be a relative path (no leading `/`) — it's the module's identity inside workerd

### Cache busting

Module imports are cached by workerd. To force re-import (hot-reload), use query strings: `import("./entry.mjs?t=1")`. The fallback service strips the query when reading from disk but preserves it in `name` so workerd treats it as a new module.

## Service Bindings (IPC bridge)

Service bindings are the primary way to bridge between workerd and Node.js.

### Async function binding (most common)

```ts
serviceBindings: {
  MY_SERVICE: async (request: Request) => {
    // Runs in Node.js, receives fetch from the worker
    return new Response("from node");
  };
}
```

Inside the worker: `env.MY_SERVICE.fetch("http://host/path")` → calls the Node.js function.

### Node.js HTTP handler binding

```ts
serviceBindings: {
  MY_HTTP: { node: (req: IncomingMessage, res: ServerResponse) => { ... } }
}
```

Bridges workerd fetch to a raw Node.js HTTP handler. Used by vite plugin for `viteDevServer.middlewares`.

## Durable Objects as Singletons

The vite plugin uses a DO with special options to maintain persistent state across requests:

```ts
durableObjects: {
  __RUNNER__: {
    className: "RunnerObject",
    unsafeUniqueKey: kUnsafeEphemeralUniqueKey, // fixed key = singleton
    unsafePreventEviction: true,                // keep alive forever
  }
}
```

- `unsafeUniqueKey` with `kUnsafeEphemeralUniqueKey` → always returns the same DO instance
- `unsafePreventEviction` → DO stays in memory between requests
- Useful for holding WebSocket connections, module caches, or other stateful resources

## Vite Plugin Architecture (reference)

The vite plugin's approach to module evaluation:

1. **Wrapper entry** → generated in-memory module that creates Proxy-based classes
2. **Runner DO** → Durable Object holding a Vite `ModuleRunner` instance + WebSocket to dev server
3. **Module evaluation flow**: Vite transforms source → sends via WebSocket → `ModuleRunner` calls `unsafeEval` to execute inside workerd
4. **HMR**: File changes → Vite sends updated transforms → `ModuleRunner` re-evaluates → no Miniflare restart

### Internal bindings used by vite plugin

| Binding                  | Type              | Purpose                                          |
| ------------------------ | ----------------- | ------------------------------------------------ |
| `__VITE_RUNNER_OBJECT__` | Durable Object    | Singleton holding ModuleRunner + WebSocket state |
| `__VITE_INVOKE_MODULE__` | Service Binding   | Synchronous RPC from workerd to Vite             |
| `__VITE_UNSAFE_EVAL__`   | Eval Binding      | Code evaluation inside workerd                   |
| `__VITE_HTML_EXISTS__`   | Service Binding   | Check if HTML file exists (for assets)           |
| `__VITE_FETCH_HTML__`    | Service Binding   | Fetch + transform HTML via Vite pipeline         |
| `__VITE_MIDDLEWARE__`    | Node HTTP Binding | Bridge to Vite dev server middleware             |

All internal bindings are stripped from user-visible `env` via `stripInternalEnv()`.

### Module resolution tricks

- **`modulesRoot: "/"`** (or `"Z:\\"` on Windows) — makes module names = absolute paths without leading `/`
- **`unsafeModuleFallbackService`** — handles `.wasm`, `.bin`, `.txt`/`.html`/`.sql` imports via special marker strings (`__CLOUDFLARE_MODULE__<type>__<path>__`)
- **Virtual modules** — `virtual:cloudflare/worker-entry`, `virtual:cloudflare/user-entry` for entry chain with HMR acceptance

### Hot-reload edge case

When exports change (e.g. adding a new DurableObject), the plugin **restarts the entire Vite dev server** because Miniflare worker options (wrapper with export declarations) need regeneration. Normal code changes use HMR without restart.
