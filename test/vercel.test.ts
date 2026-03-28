import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { VercelEnvRunner } from "../src/runners/vercel/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const headersEntry = resolve(_dir, "./fixtures/app-headers.mjs");
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("VercelEnvRunner", () => {
  let runner: VercelEnvRunner | undefined;

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
});
