import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";

import { hostEnv } from "../src/common/host-env.ts";
import { NodeWorkerEnvRunner } from "../src/runners/node-worker/runner.ts";
import { NodeProcessEnvRunner } from "../src/runners/node-process/runner.ts";
import type { EnvRunner } from "../src/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

/** Pretend the host process is an interactive terminal of the given width. */
function stubTTY(columns: number | undefined = 173) {
  const stdout = process.stdout as { isTTY?: boolean; columns?: number };
  const original = { isTTY: stdout.isTTY, columns: stdout.columns };
  stdout.isTTY = true;
  stdout.columns = columns;
  return () => {
    stdout.isTTY = original.isTTY;
    stdout.columns = original.columns;
  };
}

describe("hostEnv", () => {
  let restoreTTY: (() => void) | undefined;

  afterEach(() => {
    restoreTTY?.();
    restoreTTY = undefined;
    vi.unstubAllEnvs();
  });

  it("propagates terminal capabilities when the host is a TTY", () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("COLUMNS", undefined);
    restoreTTY = stubTTY(120);

    const env = hostEnv();
    expect(env.FORCE_COLOR).toBe("1");
    expect(env.COLUMNS).toBe("120");
  });

  it("inherits the host env and merges extra values", () => {
    vi.stubEnv("HOST_ONLY", "host");
    restoreTTY = stubTTY();

    const env = hostEnv({ EXTRA: "extra" });
    expect(env.HOST_ONLY).toBe("host");
    expect(env.EXTRA).toBe("extra");
  });

  it("does not set anything when the host is not a TTY", () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("COLUMNS", undefined);
    const stdout = process.stdout as { isTTY?: boolean; columns?: number };
    const original = { isTTY: stdout.isTTY, columns: stdout.columns };
    stdout.isTTY = false;
    stdout.columns = undefined;
    restoreTTY = () => {
      stdout.isTTY = original.isTTY;
      stdout.columns = original.columns;
    };

    const env = hostEnv();
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.COLUMNS).toBeUndefined();
  });

  it("respects NO_COLOR", () => {
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", "1");
    restoreTTY = stubTTY();

    expect(hostEnv().FORCE_COLOR).toBeUndefined();
  });

  it("respects an explicit FORCE_COLOR and COLUMNS", () => {
    vi.stubEnv("FORCE_COLOR", "0");
    vi.stubEnv("COLUMNS", "80");
    restoreTTY = stubTTY(173);

    const env = hostEnv();
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.COLUMNS).toBe("80");
  });
});

describe("terminal capabilities reach the worker", () => {
  let runner: EnvRunner | undefined;
  let restoreTTY: (() => void) | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    restoreTTY?.();
    restoreTTY = undefined;
    vi.unstubAllEnvs();
  });

  for (const [name, create] of [
    ["NodeWorkerEnvRunner", (opts: any) => new NodeWorkerEnvRunner(opts)],
    ["NodeProcessEnvRunner", (opts: any) => new NodeProcessEnvRunner(opts)],
  ] as const) {
    it(`${name} sets FORCE_COLOR and COLUMNS`, async () => {
      vi.stubEnv("FORCE_COLOR", undefined);
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("COLUMNS", undefined);
      restoreTTY = stubTTY(133);

      runner = create({ name: "test-tty", data: { entry: appEntry } });
      await waitForReady(runner);

      const env = await (await runner.fetch("http://localhost/env")).json();
      expect(env.FORCE_COLOR).toBe("1");
      expect(env.COLUMNS).toBe("133");
    });
  }
});

function waitForReady(runner: EnvRunner, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (runner.ready) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Runner did not become ready")), timeout);
    runner.onMessage(() => {
      if (runner.ready) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
