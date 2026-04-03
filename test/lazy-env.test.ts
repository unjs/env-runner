import { describe, expect, it } from "vitest";
import { createLazyEnvProxy } from "../src/common/lazy-env.ts";

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
});
