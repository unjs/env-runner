# srvx

Universal server framework for Node.js, Deno, Bun, Cloudflare Workers, and AWS Lambda. Provides a unified fetch-handler API across all runtimes.

- **Docs**: <https://srvx.h3.dev>
- **Package**: `srvx`

## Quick Start

### CLI

```bash
npx srvx serve --entry ./server.ts
```

### Programmatic

```js
import { serve } from "srvx";

const server = serve({
  fetch: (request) => new Response("Hello!"),
  port: 3000,
});

await server.ready();
console.log(`Server at ${server.url}`);
await server.close(); // Graceful shutdown
```

## Server Options

```js
serve({
  port: 3000, // Default: 3000 or PORT env
  hostname: "0.0.0.0", // Bind address
  protocol: "http", // "http" | "https"
  tls: { cert, key }, // TLS config (paths or content)
  reusePort: true, // Multiple processes on same port
  silent: true, // Suppress startup logs
  onError: (err) => {}, // Global error handler
  middleware: [], // Middleware chain
  plugins: [], // Plugin hooks
  fetch: (req) => {}, // Main request handler

  // Runtime-specific options
  node: { maxHeaderSize: 32768 },
  bun: {
    /* bun serve opts */
  },
  deno: {
    /* deno serve opts */
  },
});
```

## Server Instance

```js
const server = serve({ fetch: handler });
await server.ready(); // Wait until listening
server.url; // e.g. "http://localhost:3000"
server.port; // 3000
server.addr; // Bound address
server.options; // Resolved options
await server.close(); // Graceful shutdown
```

## Extended Request Properties

```js
serve({
  fetch(request) {
    request.ip; // Client IP
    request.waitUntil(promise); // Background tasks
    request.runtime; // { .bun, .deno, .node }
    return new Response(`Visited ${request.url}`);
  },
});
```

## Middleware

Middleware functions intercept requests/responses. They receive the request and a `next()` function:

```js
const xPoweredBy = async (req, next) => {
  const res = await next();
  res.headers.set("X-Powered-By", "srvx");
  return res;
};

serve({
  middleware: [xPoweredBy],
  fetch: handler,
});
```

## Plugins

Plugins customize the server at setup time. They receive the server instance and can modify options/middleware:

```js
const devLogs = (server) => {
  if (process.env.NODE_ENV !== "production") {
    server.options.middleware.push((req, next) => {
      console.log(`[${req.method}] ${req.url}`);
      return next();
    });
  }
};

serve({ plugins: [devLogs], fetch: handler });
```

## Node.js Specifics

### FastResponse

Performance-optimized `Response` for Node.js:

```js
import { serve, FastResponse } from "srvx";

serve({
  fetch: () => new FastResponse("Hello!"),
});
```

### Convert Node Handlers to Fetch

```js
import { toFetchHandler } from "srvx/node";
import express from "express";

const app = express().get("/", (req, res) => res.send("Hello"));
const fetchHandler = toFetchHandler(app);
```

## AWS Lambda Adapter

```js
import { toLambdaHandler } from "srvx/aws-lambda";

export const handler = toLambdaHandler({
  fetch(req) {
    return Response.json({ hello: "world!" });
  },
});
```

Supports API Gateway v1/v2, response streaming (`handleLambdaEventWithStream`), and local testing (`invokeLambdaHandler`).

## CLI Commands

```bash
srvx serve [options]       # Start server
srvx fetch [options] [url] # Make HTTP requests

# Common flags
--entry <file>    # Server entry file
-p, --port <port> # Listen port
--host <host>     # Bind address
--tls             # Enable HTTPS
--cert, --key     # TLS files
```

## Exports

| Path              | Description                               |
| ----------------- | ----------------------------------------- |
| `srvx`            | Main (auto-resolves runtime)              |
| `srvx/node`       | Node.js-specific (`toFetchHandler`, etc.) |
| `srvx/deno`       | Deno-specific                             |
| `srvx/bun`        | Bun-specific                              |
| `srvx/cloudflare` | Cloudflare Workers                        |
| `srvx/aws-lambda` | Lambda adapter                            |
| `srvx/static`     | Static file serving                       |

## Bundler Integration

```js
// Rollup — mark as external
export default { external: ["srvx"] };

// esbuild — set runtime condition
await build({ conditions: ["node"] }); // or "deno", "bun"
```
