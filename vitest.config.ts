import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/common/**/*.ts", "src/runners/**/*.ts"],
      exclude: ["dist/**", "test/**", "**/*.d.ts", "src/runners/**/worker.ts"],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 80,
        statements: 80,
      },
    },
  },
});
