import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as api from "../src/index.ts";
import { loadRunner } from "../src/loader.ts";
import type { EnvRunner } from "../src/types.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

/** Returns true when the given runtime binary is available on PATH. */
function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("index exports", () => {
  it("exports core runtime APIs", () => {
    expect(typeof api.loadRunner).toBe("function");
    expect(typeof api.RunnerManager).toBe("function");
    expect(typeof api.EnvServer).toBe("function");
    expect(typeof api.BaseEnvRunner).toBe("function");
    expect(typeof api.DenoProcessEnvRunner).toBe("function");
    expect(typeof api.MiniflareEnvRunner).toBe("function");
    expect(typeof api.VercelEnvRunner).toBe("function");
    expect(typeof api.NetlifyEnvRunner).toBe("function");
  });
});

describe("loadRunner", () => {
  let runners: EnvRunner[] = [];

  afterEach(async () => {
    for (const runner of runners) {
      await runner.close();
    }
    runners = [];
  });

  it("loads the self runner", async () => {
    const runner = await loadRunner("self", {
      name: "loader-self",
      data: { entry: appEntry },
    });
    runners.push(runner);

    await runner.waitForReady(5000);
    const res = await runner.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("loads the node-worker runner", async () => {
    const runner = await loadRunner("node-worker", {
      name: "loader-node-worker",
      data: { entry: appEntry },
      workerEntry: resolve(_dir, "../src/runners/node-worker/worker.ts"),
    });
    runners.push(runner);

    await runner.waitForReady(5000);
    const res = await runner.fetch("http://localhost/");
    expect(await res.text()).toBe("ok");
  });

  it("loads process-based runners when runtimes are available", async () => {
    const nodeRunner = await loadRunner("node-process", {
      name: "loader-node-process",
      data: { entry: appEntry },
      workerEntry: resolve(_dir, "../src/runners/node-process/worker.ts"),
    });
    runners.push(nodeRunner);
    await nodeRunner.waitForReady(5000);

    if (hasRuntime("bun")) {
      const bunRunner = await loadRunner("bun-process", {
        name: "loader-bun-process",
        data: { entry: appEntry },
        workerEntry: resolve(_dir, "../src/runners/bun-process/worker.ts"),
      });
      runners.push(bunRunner);
      await bunRunner.waitForReady(5000);
    }

    if (hasRuntime("deno")) {
      const denoRunner = await loadRunner("deno-process", {
        name: "loader-deno-process",
        data: { entry: appEntry },
        workerEntry: resolve(_dir, "../src/runners/deno-process/worker.ts"),
      });
      runners.push(denoRunner);
      await denoRunner.waitForReady(5000);
    }
  });
});
