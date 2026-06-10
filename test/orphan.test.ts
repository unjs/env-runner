import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression tests for https://github.com/unjs/env-runner/issues/23:
// workers must exit when the supervisor dies non-gracefully (SIGKILL) instead
// of being reparented to PID 1 and continuing to serve requests.

function hasRuntime(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasBun = hasRuntime("bun");

const _dir = dirname(fileURLToPath(import.meta.url));
const supervisorEntry = resolve(_dir, "./fixtures/orphan-supervisor.mjs");

// The worker keeps serving HTTP while alive, so probe its port instead of the
// pid: a killed-but-unreaped worker is a zombie that still passes kill(pid, 0).
async function fetchWorker(address: { host?: string; port: number }): Promise<string | undefined> {
  try {
    const res = await fetch(`http://${address.host || "127.0.0.1"}:${address.port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return await res.text();
  } catch {
    return undefined; // connection refused — worker is gone
  }
}

const cases: { name: string; runner: string; skip?: boolean; bunHost?: boolean }[] = [
  { name: "NodeProcessEnvRunner", runner: "node-process" },
  { name: "BunProcessEnvRunner (node host)", runner: "bun-process", skip: !hasBun },
  { name: "BunProcessEnvRunner (bun host)", runner: "bun-process", bunHost: true, skip: !hasBun },
];

describe("orphan workers on supervisor death", () => {
  for (const c of cases) {
    const exec = c.bunHost ? "bun" : process.execPath;
    it.skipIf(c.skip ?? false)(
      `${c.name}: worker exits when supervisor is SIGKILLed`,
      { timeout: 20_000 },
      async () => {
        const supervisor = spawn(exec, [supervisorEntry, c.runner], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let workerPid: number | undefined;
        try {
          // Wait for the supervisor to report the worker pid + address
          let stderr = "";
          supervisor.stderr!.on("data", (chunk) => (stderr += chunk));
          const info = await new Promise<{
            workerPid: number;
            address: { host?: string; port: number };
          }>((resolve, reject) => {
            let buf = "";
            supervisor.stdout!.on("data", (chunk) => {
              buf += chunk;
              const line = buf.split("\n").find((l) => l.startsWith("{"));
              if (line) resolve(JSON.parse(line));
            });
            supervisor.once("exit", (code) =>
              reject(new Error(`supervisor exited early (code ${code}): ${stderr}`)),
            );
            setTimeout(
              () => reject(new Error(`timeout waiting for supervisor: ${stderr}`)),
              10_000,
            );
          });
          workerPid = info.workerPid;

          // Sanity check: worker is serving before the supervisor dies
          expect(await fetchWorker(info.address)).toBe(String(workerPid));

          // Simulate non-graceful supervisor death (no IPC shutdown message)
          supervisor.kill("SIGKILL");

          // The worker should exit shortly after the IPC channel closes
          let alive: string | undefined;
          const deadline = Date.now() + 5000;
          do {
            await new Promise((r) => setTimeout(r, 100));
            alive = await fetchWorker(info.address);
          } while (alive !== undefined && Date.now() < deadline);

          expect(alive, `worker ${workerPid} kept serving after supervisor death`).toBeUndefined();
        } finally {
          supervisor.kill("SIGKILL");
          if (workerPid) {
            try {
              process.kill(workerPid, "SIGKILL"); // clean up orphan if the test failed
            } catch {}
          }
        }
      },
    );
  }
});

// The disconnect handler must be registered before the entry import, otherwise a
// supervisor death during a slow import (e.g. opening DB pools) is missed: the
// `disconnect` event fires with no listener and is never replayed, so the worker
// keeps running until the import completes — or forever, if it never does.
describe("orphan workers on supervisor death during entry import", () => {
  for (const c of cases) {
    const exec = c.bunHost ? "bun" : process.execPath;
    it.skipIf(c.skip ?? false)(
      `${c.name}: worker exits when supervisor is SIGKILLed mid-import`,
      { timeout: 20_000 },
      async () => {
        const markerDir = mkdtempSync(join(tmpdir(), "env-runner-orphan-"));
        const startedMarker = join(markerDir, "import-started");
        const finishedMarker = join(markerDir, "import-finished");
        const supervisor = spawn(exec, [supervisorEntry, c.runner, "app-slow-import.mjs"], {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, ORPHAN_TEST_MARKER_DIR: markerDir },
        });
        try {
          // Wait for the worker to begin importing the entry
          const deadline = Date.now() + 10_000;
          while (!existsSync(startedMarker)) {
            if (supervisor.exitCode !== null) {
              throw new Error(`supervisor exited early (code ${supervisor.exitCode})`);
            }
            if (Date.now() > deadline) {
              throw new Error("timeout waiting for the worker to start importing");
            }
            await new Promise((r) => setTimeout(r, 50));
          }

          // Simulate non-graceful supervisor death while the import is in flight
          supervisor.kill("SIGKILL");

          // The import sleeps 3s; the worker must exit at IPC disconnect instead
          // of completing it (a hanging import would otherwise orphan forever)
          await new Promise((r) => setTimeout(r, 4500));
          expect(
            existsSync(finishedMarker),
            "worker survived supervisor death through the entry import",
          ).toBe(false);
        } finally {
          supervisor.kill("SIGKILL");
          if (existsSync(startedMarker)) {
            try {
              process.kill(Number(readFileSync(startedMarker, "utf8")), "SIGKILL");
            } catch {}
          }
          rmSync(markerDir, { recursive: true, force: true });
        }
      },
    );
  }
});
