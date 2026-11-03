import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("fetch keep-alive", () => {
  let runner: NodeWorkerEnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
  });

  // The worker's HTTP server closes idle sockets after its keep-alive timeout
  // (5s in Node), so a pooled socket reused after that races the close.
  it("does not reuse a pooled socket the worker has closed", async () => {
    runner = new NodeWorkerEnvRunner({ name: "keep-alive", data: { entry: appEntry } });
    await runner.waitForReady();

    for (let i = 0; i < 6; i++) {
      const res = await runner.fetch(
        new Request("http://localhost/echo", { method: "POST", body: String(i) }),
      );
      expect(await res.json()).toEqual({ body: String(i), method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  }, 60_000);
});
