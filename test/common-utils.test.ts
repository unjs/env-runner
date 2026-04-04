import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLazyEnvProxy } from "../src/common/lazy-env.ts";
import {
  parseServerAddress,
  reloadEntryModule,
  resolveEntry,
  type AppEntry,
} from "../src/common/worker-utils.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("createLazyEnvProxy", () => {
  it("reads process.env lazily", () => {
    const key = "ENV_RUNNER_LAZY_TEST_KEY";
    const previous = process.env[key];

    try {
      process.env[key] = "v1";
      const env = createLazyEnvProxy();
      expect(env[key]).toBe("v1");

      process.env[key] = "v2";
      expect(env[key]).toBe("v2");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("keeps explicit overrides higher priority", () => {
    const key = "ENV_RUNNER_LAZY_OVERRIDE_KEY";
    const previous = process.env[key];

    try {
      process.env[key] = "from-process";
      const env = createLazyEnvProxy({
        [key]: "from-override",
      });

      expect(env[key]).toBe("from-override");
      process.env[key] = "from-process-updated";
      expect(env[key]).toBe("from-override");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("supports proxy trap behavior for keys, membership, set, and delete", () => {
    const key = "ENV_RUNNER_LAZY_TRAP_KEY";
    const setKey = "ENV_RUNNER_LAZY_TRAP_SET_KEY";
    const overrideOnlyKey = "ENV_RUNNER_LAZY_TRAP_OVERRIDE_ONLY";
    const previous = process.env[key];

    try {
      process.env[key] = "from-process";
      const env = createLazyEnvProxy({
        [key]: "from-override",
        [overrideOnlyKey]: "override-only",
      });

      expect(key in env).toBe(true);
      expect(overrideOnlyKey in env).toBe(true);

      const keys = Object.keys(env);
      expect(keys).toContain(key);
      expect(keys).toContain(overrideOnlyKey);

      const entries = Object.entries(env);
      expect(entries).toContainEqual([key, "from-override"]);
      expect(entries).toContainEqual([overrideOnlyKey, "override-only"]);

      env[setKey] = "x";
      expect(env[setKey]).toBe("x");
      expect(setKey in env).toBe(true);

      delete env[setKey];
      expect(env[setKey]).toBeUndefined();
      expect(setKey in env).toBe(false);

      delete env[key];
      expect(env[key]).toBe("from-process");
      expect(key in env).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      delete process.env[setKey];
      delete process.env[overrideOnlyKey];
    }
  });

  it("handles non-string and missing property paths", () => {
    const key = "ENV_RUNNER_LAZY_TRAP_MISSING";
    const env = createLazyEnvProxy();
    const symbolKey = Symbol("env-key");

    expect(Reflect.get(env as Record<PropertyKey, unknown>, symbolKey)).toBeUndefined();
    expect(Reflect.has(env as Record<PropertyKey, unknown>, symbolKey)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(env, key)).toBeUndefined();
    expect(Reflect.set(env as Record<PropertyKey, unknown>, symbolKey, "x")).toBe(false);
    expect(Reflect.deleteProperty(env as Record<PropertyKey, unknown>, symbolKey)).toBe(false);
  });
});

describe("worker-utils", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("resolves an entry module from an absolute path", async () => {
    const entry = await resolveEntry(appEntry);
    expect(typeof entry.fetch).toBe("function");
  });

  it("resolves an entry module with query params", async () => {
    const entry = await resolveEntry(`${appEntry}?t=${Date.now()}`);
    expect(typeof entry.fetch).toBe("function");
  });

  it("throws when resolved entry is missing fetch", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-worker-utils-"));
    const badEntryPath = join(tmpDir, "bad-entry.mjs");
    writeFileSync(badEntryPath, `export default {}`);

    await expect(resolveEntry(badEntryPath)).rejects.toThrow("must export a `fetch` handler");
  });

  it("parses server address from url", () => {
    const address = parseServerAddress({
      url: "http://127.0.0.1:4321/",
    } as any);
    expect(address).toEqual({ host: "127.0.0.1", port: 4321 });
  });

  it("reloads entry module and re-initializes IPC", async () => {
    tmpDir = mkdtempSync(join(_dir, ".tmp-worker-utils-"));
    const entryPath = join(tmpDir, "reload-entry.mjs");
    writeFileSync(
      entryPath,
      `
let opened = false;
export default {
  fetch() { return new Response(opened ? "opened" : "closed"); },
  ipc: {
    onOpen(ctx) { opened = true; ctx.sendMessage({ type: "opened" }); },
    onClose() { opened = false; },
  },
};
`,
    );

    const onClose = vi.fn();
    const currentEntry = {
      fetch: () => new Response("current"),
      ipc: {
        onClose,
      },
    } as unknown as AppEntry;

    const messages: unknown[] = [];
    const newEntry = await reloadEntryModule(entryPath, currentEntry, (message) => {
      messages.push(message);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(typeof newEntry.fetch).toBe("function");
    expect(messages).toContainEqual({ type: "opened" });

    const response = await newEntry.fetch(new Request("http://localhost/"));
    expect(await response.text()).toBe("opened");
  });
});
