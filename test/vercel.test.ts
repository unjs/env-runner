import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from "vitest";
import { VercelEnvRunner } from "../src/runners/vercel/runner.ts";

// Fake unsigned JWT with a far-future `exp` to silence the Vercel OIDC token warning
const fakeVercelOidcToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.x`;

const _dir = dirname(fileURLToPath(import.meta.url));
const headersEntry = resolve(_dir, "./fixtures/app-headers.mjs");
const envEntry = resolve(_dir, "./fixtures/app-env.mjs");
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("VercelEnvRunner", () => {
  let runner: VercelEnvRunner | undefined;

  beforeAll(() => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", process.env.VERCEL_OIDC_TOKEN || fakeVercelOidcToken);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it("starts and becomes ready", async () => {
    runner = new VercelEnvRunner({ name: "test", data: { entry: appEntry } });
    await runner.waitForReady();
    expect(runner.ready).toBe(true);
  });

  it("fetches from runner", async () => {
    runner = new VercelEnvRunner({ name: "test-fetch", data: { entry: appEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("injects x-vercel-deployment-url header", async () => {
    runner = new VercelEnvRunner({ name: "test-deploy-url", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-vercel-deployment-url"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("injects x-vercel-forwarded-for header", async () => {
    runner = new VercelEnvRunner({ name: "test-vff", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-vercel-forwarded-for"]).toBe("127.0.0.1");
  });

  it("injects x-forwarded-for header", async () => {
    runner = new VercelEnvRunner({ name: "test-xff", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("injects x-real-ip header", async () => {
    runner = new VercelEnvRunner({ name: "test-xri", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-real-ip"]).toBe("127.0.0.1");
  });

  it("injects x-forwarded-proto header", async () => {
    runner = new VercelEnvRunner({ name: "test-xfp", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-proto"]).toBe("http");
  });

  it("injects x-forwarded-host header", async () => {
    runner = new VercelEnvRunner({ name: "test-xfh", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-host"]).toBe("localhost");
  });

  it("preserves existing x-forwarded-for from request", async () => {
    runner = new VercelEnvRunner({ name: "test-preserve-xff", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch(
      new Request("http://localhost/", {
        headers: { "x-forwarded-for": "203.0.113.50" },
      }),
    );
    const headers = await res.json();
    expect(headers["x-forwarded-for"]).toBe("203.0.113.50");
    expect(headers["x-vercel-forwarded-for"]).toBe("203.0.113.50");
    expect(headers["x-real-ip"]).toBe("203.0.113.50");
  });

  it("preserves existing x-real-ip from request", async () => {
    runner = new VercelEnvRunner({ name: "test-preserve-xri", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch(
      new Request("http://localhost/", {
        headers: { "x-real-ip": "198.51.100.1" },
      }),
    );
    const headers = await res.json();
    expect(headers["x-real-ip"]).toBe("198.51.100.1");
    expect(headers["x-vercel-forwarded-for"]).toBe("198.51.100.1");
  });

  it("does not overwrite pre-existing vercel headers", async () => {
    runner = new VercelEnvRunner({ name: "test-no-overwrite", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch(
      new Request("http://localhost/", {
        headers: {
          "x-vercel-deployment-url": "https://my-app.vercel.app",
          "x-vercel-forwarded-for": "10.0.0.1",
        },
      }),
    );
    const headers = await res.json();
    expect(headers["x-vercel-deployment-url"]).toBe("https://my-app.vercel.app");
    expect(headers["x-vercel-forwarded-for"]).toBe("10.0.0.1");
  });

  it("injects x-vercel-id request header", async () => {
    runner = new VercelEnvRunner({ name: "test-vid", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-vercel-id"]).toMatch(/^dev1::\w+-\w+-[\da-f]{12}$/);
  });

  it("sets vercel response headers", async () => {
    runner = new VercelEnvRunner({ name: "test-res-headers", data: { entry: appEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    expect(res.headers.get("server")).toBe("Vercel");
    expect(res.headers.get("x-vercel-id")).toMatch(/^dev1::/);
    expect(res.headers.get("x-vercel-cache")).toBe("MISS");
  });

  it("sets vercel environment variables in worker", async () => {
    runner = new VercelEnvRunner({ name: "test-env", data: { entry: envEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const { env } = await res.json();
    expect(env.VERCEL).toBe("1");
    expect(env.VERCEL_ENV).toBe("development");
    // NODE_ENV is inherited from parent (vitest sets it to "test"); the worker only defaults it when unset.
    expect(env.NODE_ENV).toBe(process.env.NODE_ENV);
    // VERCEL_REGION / NOW_REGION are intentionally not defaulted; Vercel SDKs expect valid region identifiers when set.
    expect(env.VERCEL_REGION).toBeUndefined();
    expect(env.NOW_REGION).toBeUndefined();
  });
});
