import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvServer } from "../src/server.ts";

const _dir = dirname(fileURLToPath(import.meta.url));

describe("EnvServer", () => {
  let tmpDir: string | undefined;
  let server: EnvServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("starts, proxies fetch, and closes", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-server-"));
    const entryPath = join(tmpDir, "entry.mjs");
    writeFileSync(
      entryPath,
      `export default { fetch() { return new Response("v1"); } };`,
    );

    server = new EnvServer({
      runner: "self",
      entry: entryPath,
      name: "server-self",
    });
    await server.start();

    let res: Response | undefined;
    for (let i = 0; i < 100; i++) {
      res = await server.fetch("http://localhost/");
      if (res.status === 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(res?.status).toBe(200);
    expect(await res!.text()).toBe("v1");

    await server.close();
    const unavailable = await server.fetch("http://localhost/");
    expect(unavailable.status).toBe(503);
    server = undefined;
  }, 15000);

  it("reloads when scheduled and notifies listeners", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-server-"));
    const entryPath = join(tmpDir, "entry.mjs");
    writeFileSync(
      entryPath,
      `export default { fetch() { return new Response("v1"); } };`,
    );

    server = new EnvServer({
      runner: "self",
      entry: entryPath,
      name: "server-reload",
    });
    await server.start();

    const reloadSpy = vi.fn();
    server.onReload(reloadSpy);

    writeFileSync(
      entryPath,
      `export default { fetch() { return new Response("v2"); } };`,
    );
    (server as any)._scheduleReload();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    let responseBody = "";
    for (let i = 0; i < 20; i++) {
      const res = await server.fetch("http://localhost/");
      responseBody = await res.text();
      if (res.status === 200 && responseBody === "v2") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(responseBody).toBe("v2");

    server.offReload(reloadSpy);
  });

  it("logs errors when scheduled reload fails", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-server-"));
    const entryPath = join(tmpDir, "entry.mjs");
    writeFileSync(
      entryPath,
      `export default { fetch() { return new Response("ok"); } };`,
    );

    server = new EnvServer({
      runner: "self",
      entry: entryPath,
      name: "server-reload-error",
    });
    await server.start();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (server as any)._createRunner = async () => {
      throw new Error("reload-failed");
    };
    (server as any)._scheduleReload();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
