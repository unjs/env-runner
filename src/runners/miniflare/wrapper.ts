const IPC_PATH = "/__env_runner_ipc";

/** Service binding name used for cross-request IPC (worker → runner). */
export const IPC_BINDING = "__ENV_RUNNER_IPC";

/** Binding name for workerd's `UnsafeEval` API (used to import the entry). */
export const UNSAFE_EVAL_BINDING = "__ENV_RUNNER_UNSAFE_EVAL__";

/**
 * Generates a wrapper module that imports the user entry and adds IPC glue.
 *
 * The user module is expected to export `fetch` and optionally `ipc`.
 *
 * Requests are handled like srvx's Cloudflare adapter (`srvx/cloudflare`):
 * `plugins` run against a server-like object, `error` and `middleware` wrap
 * `fetch`, and the request is augmented with `runtime` (`{ name: "cloudflare",
 * cloudflare: { env, context } }`), `ip` (`cf-connecting-ip`) and `waitUntil`.
 * `fetch` still receives `(request, env, ctx)` for Workers-style entries. The
 * `env` the entry sees never contains env-runner's internal bindings.
 *
 * The wrapper uses a persistent WebSocket pair for bidirectional IPC:
 * - Init: `fetch` with `upgrade: websocket` creates a WebSocketPair
 * - Messages: JSON over the WebSocket (no per-message `dispatchFetch`)
 * - Reload: `{ type: "reload" }` triggers cache-busted re-import
 * - Shutdown: `{ type: "shutdown" }` calls `ipc.onClose()`
 *
 * For outgoing messages during fetch request handling, uses a service binding
 * (`__ENV_RUNNER_IPC`) to avoid workerd's cross-request I/O restriction on
 * the WebSocket object.
 *
 * Passed as an in-memory `script` to Miniflare (no temp files needed).
 */
export function generateWrapper(
  entryPath: string,
  opts?: { dynamicOnly?: boolean; captureErrors?: boolean; exports?: string[] },
): string {
  // When dynamicOnly is set, skip static `export *` to avoid miniflare's
  // ModuleLocator walking the entry's import tree at startup. All module
  // loading goes through dynamic import() via unsafeEvalBinding instead.
  const staticReExport = opts?.dynamicOnly ? "" : `export * from ${JSON.stringify(entryPath)};`;

  // In dynamicOnly mode, we still need explicit re-exports for DO/Entrypoint
  // classes since workerd requires them as static named exports.
  const explicitExports =
    opts?.dynamicOnly && opts.exports?.length
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

  return /* js */ `import __process from "node:process";
if (!globalThis.process) { globalThis.process = __process; }
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
let __currentEnv;

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

function __sendMessage(message) {
  const payload = JSON.stringify(message);
  const env = __currentEnv;
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

    // WebSocket IPC handshake
    if (url.pathname === __IPC_PATH && request.headers.get("upgrade") === "websocket") {
      try {
        if (!__userEntry) {
          const entry = await __loadEntry(env, __entryPath);
          __server = __createServer(entry);
          __userEntry = entry;
        }
      } catch (e) {
        return new Response("Failed to load entry: " + String(e), { status: 500 });
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

    // Handle WebSocket upgrade via crossws cloudflare adapter
    if (__userEntry.websocket && request.headers.get("upgrade") === "websocket") {
      const adapter = await __initCrossws(env, __userEntry.websocket);
      return adapter.handleUpgrade(request, __userEnv(env), ctx);
    }

    __currentEnv = env;
    try {
      ${fetchBody}
    } finally {
      __currentEnv = undefined;
    }
  }
};
`;
}
