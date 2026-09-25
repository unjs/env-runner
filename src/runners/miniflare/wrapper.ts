const IPC_PATH = "/__env_runner_ipc";

/** Service binding name used for cross-request IPC (worker → runner). */
export const IPC_BINDING = "__ENV_RUNNER_IPC";

/** Binding name for workerd's `UnsafeEval` API (used to import the entry). */
export const UNSAFE_EVAL_BINDING = "__ENV_RUNNER_UNSAFE_EVAL__";

/**
 * Wrapper module around the user entry. Requests are handled like
 * `srvx/cloudflare`; `fetch` also receives `(request, env, ctx)`. IPC uses a
 * persistent WebSocket pair, plus `__ENV_RUNNER_IPC` for worker → host messages
 * once a user request was seen (workerd forbids cross-request I/O on the socket).
 */
export function generateWrapper(
  entryPath: string,
  opts?: {
    dynamicOnly?: boolean;
    captureErrors?: boolean;
    /** Class names re-exported from the entry, or a module specifier re-exported with `export *`. */
    exports?: string[] | string;
    /** Import `node:process` as the `process` global (needs `nodejs_compat`). Default: `true`. */
    nodeCompat?: boolean;
  },
): string {
  // Without `nodejs_compat` (`no_nodejs_compat`), `node:process` can't resolve
  // and would stop workerd from starting.
  const processShim =
    opts?.nodeCompat === false
      ? ""
      : `import __process from "node:process";
if (!globalThis.process) { globalThis.process = __process; }`;
  // Static `export *` would make ModuleLocator walk the entry's imports at startup.
  const staticReExport = opts?.dynamicOnly ? "" : `export * from ${JSON.stringify(entryPath)};`;

  // workerd requires DO/Entrypoint classes as static named exports: re-export a
  // separate exports module wholesale, or (in dynamicOnly mode) the named classes
  // from the entry.
  const explicitExports =
    typeof opts?.exports === "string"
      ? `export * from ${JSON.stringify(opts.exports)};`
      : opts?.dynamicOnly && opts.exports?.length
        ? opts.exports
            .map((name) => `export { ${name} } from ${JSON.stringify(entryPath)};`)
            .join("\n")
        : "";

  const captureErrors = opts?.captureErrors ?? true;

  const fetchBody = captureErrors
    ? /* js */ `try {
      return await __server.fetch(request, env, ctx);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const body = JSON.stringify({
        error: error.message,
        stack: error.stack,
        name: error.constructor?.name || "Error",
      });
      return new Response(body, {
        status: 500,
        headers: { "Content-Type": "application/json", "X-Env-Runner-Error": "1" },
      });
    }`
    : `return __server.fetch(request, env, ctx);`;

  return /* js */ `${processShim}
${staticReExport}
${explicitExports}

const __IPC_PATH = "${IPC_PATH}";
const __IPC_BINDING = "${IPC_BINDING}";
const __UNSAFE_EVAL_BINDING = "${UNSAFE_EVAL_BINDING}";
const __entryPath = ${JSON.stringify(entryPath)};
let __userEntry;
let __server;
let __ipcInitialized = false;
let __serverWs;
// Raw env of the latest user request. Kept after the request ends: requests
// overlap and streamed bodies outlive fetch(), and unlike \`__serverWs\` the
// IPC binding works from any request context.
let __ipcEnv;

const __userEnvs = new WeakMap();

// \`env\` without env-runner's internal bindings (cached per env object).
function __userEnv(env) {
  let userEnv = __userEnvs.get(env);
  if (!userEnv) {
    userEnv = { ...env };
    delete userEnv[__IPC_BINDING];
    delete userEnv[__UNSAFE_EVAL_BINDING];
    __userEnvs.set(env, userEnv);
  }
  return userEnv;
}

// Mirrors srvx's CloudflareServer (srvx/cloudflare): plugins, then the
// \`error\` handler as the outermost middleware, then the middleware chain.
function __createServer(entry) {
  const server = {
    runtime: "cloudflare",
    options: {
      ...entry,
      middleware: [...(entry.middleware || [])],
      fetch: entry.fetch
        ? (request) =>
            entry.fetch(request, request.runtime?.cloudflare?.env, request.runtime?.cloudflare?.context)
        : () => new Response("No fetch handler exported", { status: 500 }),
    },
    serve() {},
    ready: () => Promise.resolve(server),
    close: () => Promise.resolve(),
  };
  for (const plugin of entry.plugins || []) {
    plugin(server);
  }
  const errorHandler = server.options.error;
  if (errorHandler) {
    server.options.middleware.unshift((_request, next) => {
      try {
        const res = next();
        return typeof res?.then === "function" ? res.then(undefined, (error) => errorHandler(error)) : res;
      } catch (error) {
        return errorHandler(error);
      }
    });
  }
  let handler = server.options.fetch;
  const middleware = server.options.middleware;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    const next = handler;
    handler = (request) => mw(request, () => next(request));
  }
  server.fetch = (request, env, context) => {
    const userEnv = __userEnv(env);
    Object.defineProperties(request, {
      waitUntil: { value: context.waitUntil.bind(context) },
      runtime: {
        enumerable: true,
        value: { name: "cloudflare", cloudflare: { env: userEnv, context } },
      },
      ip: {
        enumerable: true,
        configurable: true,
        get() {
          return request.headers.get("cf-connecting-ip");
        },
      },
    });
    return handler(request);
  };
  return server;
}

async function __loadEntry(env, path) {
  globalThis.__ENV_RUNNER_UNSAFE_EVAL__ = env.__ENV_RUNNER_UNSAFE_EVAL__;
  const importFn = env.__ENV_RUNNER_UNSAFE_EVAL__.newAsyncFunction(
    "return await import(path)",
    "loadEntry",
    "path"
  );
  const mod = await importFn(path);
  return mod.default || mod;
}

// Where an entry load error was thrown (first stack frame), so one thrown by a
// virtual module names its key (\`#config:2:7\`). workerd's messages don't.
function __errorLocation(e) {
  const location = /\\n\\s+at (?:async )?(?:.* \\()?([^\\n()]+:\\d+:\\d+)\\)?/.exec(String(e?.stack))?.[1];
  return location ? " (at " + location + ")" : "";
}

function __sendMessage(message) {
  const payload = JSON.stringify(message);
  const env = __ipcEnv;
  if (env && env[__IPC_BINDING]) {
    env[__IPC_BINDING].fetch("http://localhost/__ipc", {
      method: "POST",
      body: payload,
    }).catch(() => {});
    return;
  }
  if (__serverWs) {
    __serverWs.send(payload);
  }
}

async function __handleWsMessage(env, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  if (msg.type === "message") {
    if (__userEntry?.ipc?.onMessage) {
      __userEntry.ipc.onMessage(msg.data);
    }
    return;
  }

  if (msg.type === "reload" && env.__ENV_RUNNER_UNSAFE_EVAL__) {
    const version = msg.version || 0;
    try {
      const newEntry = await __loadEntry(env, __entryPath + "?t=" + version);
      const newServer = __createServer(newEntry);
      if (__userEntry?.ipc?.onClose) {
        await __userEntry.ipc.onClose();
      }
      __userEntry = newEntry;
      __server = newServer;
      __crosswsAdapter = undefined;
      __ipcInitialized = false;
      if (__userEntry.ipc?.onOpen) {
        __ipcInitialized = true;
        await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
      }
      __sendMessage({ event: "module-reloaded" });
    } catch (e) {
      __sendMessage({ event: "module-reloaded", error: String(e) });
    }
    return;
  }

  if (msg.type === "shutdown") {
    if (__userEntry?.ipc?.onClose) {
      await __userEntry.ipc.onClose();
    }
    return;
  }
}

let __crosswsAdapter;

async function __initCrossws(env, hooks) {
  if (__crosswsAdapter) return __crosswsAdapter;
  const importFn = env.__ENV_RUNNER_UNSAFE_EVAL__.newAsyncFunction(
    "return await import('crossws/adapters/cloudflare')",
    "loadCrossws"
  );
  const { default: cloudflareAdapter } = await importFn();
  __crosswsAdapter = cloudflareAdapter({ hooks });
  return __crosswsAdapter;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // IPC: a plain request loads the entry (204, or a 500 with the error), then
    // the WebSocket upgrade opens the channel.
    if (url.pathname === __IPC_PATH) {
      try {
        if (!__userEntry) {
          const entry = await __loadEntry(env, __entryPath);
          __server = __createServer(entry);
          __userEntry = entry;
        }
      } catch (e) {
        const message = "Failed to load entry: " + String(e) + __errorLocation(e);
        return new Response(message, { status: 500 });
      }
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response(null, { status: 204 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      __serverWs = server;

      server.addEventListener("message", (event) => {
        __handleWsMessage(env, event.data);
      });

      // Initialize IPC hooks
      if (!__ipcInitialized && __userEntry.ipc) {
        __ipcInitialized = true;
        if (__userEntry.ipc.onOpen) {
          await __userEntry.ipc.onOpen({ sendMessage: __sendMessage });
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (!__userEntry) {
      return new Response("Worker not initialized", { status: 503 });
    }

    __ipcEnv = env;

    // Handle WebSocket upgrade via crossws cloudflare adapter
    if (__userEntry.websocket && request.headers.get("upgrade") === "websocket") {
      const adapter = await __initCrossws(env, __userEntry.websocket);
      return adapter.handleUpgrade(request, __userEnv(env), ctx);
    }

    ${fetchBody}
  }
};
`;
}
