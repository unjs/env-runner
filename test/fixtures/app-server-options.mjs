// Exports srvx `ServerOptions` alongside `fetch` (#49). The worker must forward
// `error` / `maxRequestBodySize` to `serve()` while ignoring the listener
// options it owns (`port`, `hostname`, ...).
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/throw") {
      throw new Error("boom");
    }
    if (url.pathname === "/ip") {
      // `trustProxy` makes srvx honour x-forwarded-for
      return new Response(request.ip || "");
    }
    // Reading the body is what trips `maxRequestBodySize` (srvx limits lazily)
    const body = await request.text();
    return new Response(`ok:${body.length}`);
  },
  error(error) {
    return new Response(`handled: ${error.message}`, { status: error.status || 599 });
  },
  maxRequestBodySize: 16,
  trustProxy: true,
  // Worker-owned options — must be ignored (a fixed port would break
  // concurrent tests, a foreign hostname would break the runner's proxy).
  port: 1,
  hostname: "203.0.113.1",
  silent: false,
  manual: true,
  gracefulShutdown: true,
  // Same via the runtime-specific objects, which srvx spreads last. `http2`
  // needs TLS (dropped in the worker) and would make srvx throw.
  node: { port: 1, host: "203.0.113.1", http2: true, keepAliveTimeout: 1234 },
  bun: { port: 1, hostname: "203.0.113.1", idleTimeout: 42 },
  deno: { port: 1, hostname: "203.0.113.1" },
};
