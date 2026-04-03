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
});
