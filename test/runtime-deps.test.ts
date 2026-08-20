import { describe, expect, it } from "vitest";
import { resolveRuntimeDep, resolveRuntimeDepSpecifier } from "../src/common/runtime-deps.ts";

interface FakeModule {
  hello: () => string;
}

describe("resolveRuntimeDep", () => {
  it("returns an imported module as-is", async () => {
    const mod = { hello: () => "hi" };
    expect(await resolveRuntimeDep<FakeModule>({ name: "x", option: "x", value: mod })).toBe(mod);
  });

  it("imports a bare specifier resolved from the project", async () => {
    const mod = await resolveRuntimeDep<any>({
      name: "exsolve",
      option: "mod",
      value: "exsolve",
      expect: "resolveModulePath",
    });
    expect(typeof mod?.resolveModulePath).toBe("function");
  });

  it("imports a URL specifier", async () => {
    const mod = await resolveRuntimeDep<any>({
      name: "exsolve",
      option: "mod",
      value: new URL(import.meta.resolve("exsolve")),
    });
    expect(typeof mod?.resolveModulePath).toBe("function");
  });

  it("falls back to importing the package when omitted", async () => {
    const mod = await resolveRuntimeDep<any>({ name: "exsolve", option: "mod" });
    expect(typeof mod?.resolveModulePath).toBe("function");
  });

  it("returns undefined for `false`", async () => {
    expect(await resolveRuntimeDep({ name: "exsolve", option: "mod", value: false })).toBe(
      undefined,
    );
  });

  it("returns undefined for a missing optional package", async () => {
    expect(await resolveRuntimeDep({ name: "@env-runner/nope", option: "mod" })).toBe(undefined);
  });

  it("throws for a missing required package", async () => {
    await expect(
      resolveRuntimeDep({ name: "@env-runner/nope", option: "mod", required: true }),
    ).rejects.toThrow(/`@env-runner\/nope` package is required/);
  });

  it("throws for an explicit specifier that cannot be imported", async () => {
    await expect(
      resolveRuntimeDep({ name: "thing", option: "mod", value: "@env-runner/nope" }),
    ).rejects.toThrow(/failed to import `thing` from the `mod` specifier/);
  });

  it("throws when the resolved module lacks the expected export", async () => {
    await expect(
      resolveRuntimeDep({ name: "thing", option: "mod", value: {}, expect: "Miniflare" }),
    ).rejects.toThrow(/does not export `Miniflare`/);
  });
});

describe("resolveRuntimeDepSpecifier", () => {
  it("passes `false` and `undefined` through", () => {
    expect(resolveRuntimeDepSpecifier(false, "opt")).toBe(false);
    expect(resolveRuntimeDepSpecifier(undefined, "opt")).toBe(undefined);
  });

  it("resolves a bare specifier to an absolute file URL", () => {
    expect(resolveRuntimeDepSpecifier("exsolve", "opt")).toMatch(/^file:\/\/.*exsolve/);
  });

  it("passes a URL through", () => {
    expect(resolveRuntimeDepSpecifier(new URL("file:///a/b.mjs"), "opt")).toBe("file:///a/b.mjs");
  });

  it("throws for an imported module", () => {
    expect(() => resolveRuntimeDepSpecifier({ startRuntime: () => {} }, "netlifyRuntime")).toThrow(
      /must be a module specifier/,
    );
  });
});
