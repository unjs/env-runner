// srvx-style entry for the miniflare runner (#50): the wrapper must augment
// the request like `srvx/cloudflare` and apply `plugins`/`middleware`/`error`.
export default {
  async fetch(request, env, ctx) {
    // Response.json() headers are mutable, so middleware can decorate them
    const url = new URL(request.url);
    if (url.pathname === "/throw") {
      throw new Error("boom");
    }
    return Response.json({
      runtime: request.runtime?.name,
      runtimeEnvKeys: Object.keys(request.runtime?.cloudflare?.env || {}).sort(),
      hasContext: typeof request.runtime?.cloudflare?.context?.waitUntil === "function",
      ip: request.ip,
      waitUntil: typeof request.waitUntil,
      envKeys: Object.keys(env || {}).sort(),
      envIsRuntimeEnv: env === request.runtime?.cloudflare?.env,
      ctx: typeof ctx?.waitUntil,
    });
  },
  error(error) {
    return new Response(`handled: ${error.message}`, { status: 599 });
  },
  middleware: [
    async (_request, next) => {
      const res = await next();
      res.headers.set("x-middleware", "1");
      return res;
    },
  ],
  plugins: [
    (server) => {
      server.options.middleware.push(async (_request, next) => {
        const res = await next();
        res.headers.set("x-plugin", server.runtime);
        return res;
      });
    },
  ],
};
