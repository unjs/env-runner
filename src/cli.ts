import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "srvx";
import { EnvServer } from "./server.ts";
import type { RunnerName } from "./loader.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runner: { type: "string", default: "node-process" },
    port: { type: "string" },
    host: { type: "string" },
    watch: { type: "boolean", short: "w" },
    help: { type: "boolean" },
  },
});

const usage = `
\x1B[1mUsage:\x1B[0m env-runner \x1B[36m<entry>\x1B[0m [options]

\x1B[1mOptions:\x1B[0m
  \x1B[33m--runner\x1B[0m <name>  Runner to use (node-worker, node-process, bun-process, self, miniflare) \x1B[2m(default: node-process)\x1B[0m
  \x1B[33m--port\x1B[0m <port>    Port to listen on \x1B[2m(default: 3000)\x1B[0m
  \x1B[33m--host\x1B[0m <host>    Host to bind to \x1B[2m(default: localhost)\x1B[0m
  \x1B[33m-w, --watch\x1B[0m      Watch entry file for changes and auto-reload
  \x1B[33m-h, --help\x1B[0m       Show this help message
`.trim();

const entry = positionals[0];
if (values.help || !entry) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}

const runner = values.runner as RunnerName;

const envServer = new EnvServer({
  runner,
  entry: resolve(entry),
  watch: values.watch,
});

envServer.onReady = (_runner, address) => {
  console.log(
    `\x1B[2m➜ Worker ready on ${address?.host}:${address?.port || address?.socketPath}\x1B[0m`,
  );
};

envServer.onReload = () => {
  console.log(`\x1B[2m↻ Reloading...\x1B[0m`);
};

await envServer.start();

const server = serve({
  port: values.port,
  hostname: values.host,
  gracefulShutdown: false,
  fetch: (request) => envServer.fetch(request),
});

await server.ready();

server.node?.server?.on("upgrade", (req, socket, head) => {
  envServer.upgrade({ node: { req, socket, head } });
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    console.log(`\n\x1B[2mShutting down...\x1B[0m`);
    await envServer.close();
    await server.close();
    process.exit(0);
  });
}
