// Runs under a Bun/Deno host to exercise the `createRunnerWSProxyPlugin`
// Bun/Deno bridge end-to-end (the crossws terminate-and-redial path), which the
// Node-hosted vitest process never reaches. Stands up a backend crossws echo
// "worker" and a front srvx server carrying the proxy plugin, then prints the
// front URL as `READY <url>` for the spawning test to connect to.
import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server";
import { createRunnerWSProxyPlugin } from "../../src/common/ws-proxy.ts";

// Backend "worker": a crossws echo server (welcome on open, echo:<msg>).
const backend = serve({
  port: 0,
  hostname: "127.0.0.1",
  plugins: [
    wsPlugin({
      open: (peer) => peer.send("welcome"),
      message: (peer, message) => peer.send(`echo:${message.text()}`),
    }),
  ],
  fetch: () => new Response("backend"),
});
await backend.ready();
const backendURL = new URL(backend.url);
const runner = {
  address: { host: backendURL.hostname, port: Number(backendURL.port) },
  ready: true,
  waitForReady: async () => {},
};

// Front server on this Bun/Deno host carrying the proxy plugin under test.
const front = serve({
  port: 0,
  hostname: "127.0.0.1",
  plugins: [await createRunnerWSProxyPlugin(() => runner)],
  fetch: () => new Response("front"),
});
await front.ready();
console.log("READY " + front.url);
