// Runs under a Bun/Deno host to exercise the `createRunnerWSProxyPlugin`
// Bun/Deno bridge end-to-end (the crossws terminate-and-redial path), which the
// Node-hosted vitest process never reaches. Stands up a backend crossws echo
// "worker" and a front srvx server carrying the proxy plugin (through
// `RunnerManager.wsSrvxPlugin()`), then prints the front URL as `READY <url>`
// for the spawning test to connect to.
import { serve } from "srvx";
import { plugin as wsPlugin } from "crossws/server";
import { RunnerManager } from "../../src/manager.ts";

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

// Runners pointing at the backend; `retired` once shut down or closed. A
// `starting` runner reports its address on `start()` (the manager waits for it).
const runners = [];
function createRunner(starting = false) {
  const listeners = new Set();
  const address = { host: backendURL.hostname, port: Number(backendURL.port) };
  const runner = {
    address: starting ? undefined : address,
    get ready() {
      return !runner.closed && !!runner.address;
    },
    closed: false,
    retired: false,
    start() {
      runner.address = address;
      for (const listener of listeners) listener({ address });
    },
    waitForReady: async () => {},
    onMessage: (listener) => listeners.add(listener),
    offMessage: (listener) => listeners.delete(listener),
    sendMessage() {},
    fetch: async () => new Response("runner"),
    shutdown: () => runner.close(),
    close: async () => {
      runner.retired = runner.closed = true;
    },
  };
  runners.push(runner);
  return runner;
}
const manager = new RunnerManager(createRunner());

// Front server on this Bun/Deno host carrying the proxy plugin under test:
// - `/reload` swaps in a new runner with `drain`
// - `/reload-starting` swaps in one that is still starting, `/start` starts it
// - `/retired?runner=<index>` reports a runner (`0` is the first one)
const front = serve({
  port: 0,
  hostname: "127.0.0.1",
  plugins: [await manager.wsSrvxPlugin()],
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/reload") {
      await manager.reload(createRunner(), { drain: true });
      return new Response("reloaded");
    }
    if (pathname === "/reload-starting") {
      await manager.reload(createRunner(true));
      return new Response("reloaded");
    }
    if (pathname === "/start") {
      runners.at(-1).start();
      return new Response("started");
    }
    if (pathname === "/retired") {
      return new Response(String(runners[Number(searchParams.get("runner") || 0)].retired));
    }
    return new Response("front");
  },
});
await front.ready();
console.log("READY " + front.url);
