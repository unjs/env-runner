import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { EnvServer } from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("EnvServer", () => {
  let server: EnvServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("auto-starts on first fetch", async () => {
    server = new EnvServer({ entry: appEntry });
    const res = await server.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("start() is idempotent and shared by concurrent fetches", async () => {
    server = new EnvServer({ entry: appEntry });
    const [res1, res2] = await Promise.all([
      server.fetch("http://localhost/"),
      server.fetch("http://localhost/"),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const runner = server.runner;
    expect(runner).toBeTruthy();
    await server.start();
    expect(server.runner).toBe(runner);
  });

  it("reload() without an argument creates a fresh runner", async () => {
    server = new EnvServer({ entry: appEntry });
    await server.start();
    const runner = server.runner;
    expect(runner).toBeTruthy();

    await server.reload();
    expect(server.runner).toBeTruthy();
    expect(server.runner).not.toBe(runner);
    expect(runner!.closed).toBe(true);

    const res = await server.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("does not restart after close", async () => {
    server = new EnvServer({ entry: appEntry });
    await server.start();
    await server.close();
    const res = await server.fetch("http://localhost/");
    expect(res.status).toBe(503);
  });

  it("propagates start errors to fetch and resets for retry", async () => {
    server = new EnvServer({ entry: appEntry, runner: "unknown" as never });
    await expect(server.fetch("http://localhost/")).rejects.toThrow();
    // A failed start resets the shared promise, so the next fetch retries
    await expect(server.fetch("http://localhost/")).rejects.toThrow();
  });

  it("fetch after invalidateModule reloads the entry automatically", async () => {
    let counter = 0;
    server = new EnvServer({
      entry: "#entry",
      data: {
        virtual: {
          "#entry": `import config from "#config.json";
            export default { fetch: () => new Response(String(config.count)) };`,
          "#config.json": () => JSON.stringify({ count: counter++ }),
        },
      },
    });
    await server.start();
    expect(await (await server.fetch("http://localhost/")).text()).toBe("0");

    // No explicit reloadModule(): the next fetch flushes the invalidation
    await server.invalidateModule("#config.json");
    expect(await (await server.fetch("http://localhost/")).text()).toBe("1");
  });
});
