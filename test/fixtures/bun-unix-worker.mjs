// Custom node-worker entry (like Nitro's dev worker) serving on a unix socket,
// with a small `maxRequestBodySize` so larger bodies get an early `413`.
import { parentPort, workerData } from "node:worker_threads";

Bun.serve({
  unix: workerData.socketPath,
  maxRequestBodySize: 64 * 1024,
  fetch: async (request) => new Response(String((await request.text()).length)),
});
parentPort.postMessage({ address: { socketPath: workerData.socketPath } });
