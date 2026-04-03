import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { NetlifyEnvRunner } from "../src/runners/netlify/runner.ts";

const _dir = dirname(fileURLToPath(import.meta.url));
const headersEntry = resolve(_dir, "./fixtures/app-headers.mjs");
const appEntry = resolve(_dir, "./fixtures/app.mjs");

describe("NetlifyEnvRunner", () => {
  let runner: NetlifyEnvRunner | undefined;

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it("starts and becomes ready", async () => {
    runner = new NetlifyEnvRunner({ name: "test", data: { entry: appEntry } });
    await runner.waitForReady();
    expect(runner.ready).toBe(true);
  });

  it("fetches from runner", async () => {
    runner = new NetlifyEnvRunner({ name: "test-fetch", data: { entry: appEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("injects x-nf-client-connection-ip header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-ip", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-client-connection-ip"]).toBe("127.0.0.1");
  });

  it("injects x-nf-account-id header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-account", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-account-id"]).toBe("0");
  });

  it("injects x-nf-site-id header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-site", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-site-id"]).toBe("0");
  });

  it("injects x-nf-deploy-id header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-deploy", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-deploy-id"]).toBe("0");
  });

  it("injects x-nf-deploy-context header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-ctx", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-deploy-context"]).toBe("dev");
  });

  it("injects x-nf-geo header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-geo", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    const geo = JSON.parse(atob(headers["x-nf-geo"]));
    expect(geo.city).toBe("localhost");
    expect(geo.country.code).toBe("dev");
  });

  it("injects x-nf-request-id header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-reqid", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-nf-request-id"]).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    );
  });

  it("injects x-forwarded-for header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-xff", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("injects x-forwarded-proto header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-xfp", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-proto"]).toBe("http");
  });

  it("injects x-forwarded-host header", async () => {
    runner = new NetlifyEnvRunner({ name: "test-xfh", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch("http://localhost/");
    const headers = await res.json();
    expect(headers["x-forwarded-host"]).toBe("localhost");
  });

  it("derives client IP from x-forwarded-for", async () => {
    runner = new NetlifyEnvRunner({ name: "test-derive-ip", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch(
      new Request("http://localhost/", {
        headers: { "x-forwarded-for": "203.0.113.50" },
      }),
    );
    const headers = await res.json();
    expect(headers["x-forwarded-for"]).toBe("203.0.113.50");
    expect(headers["x-nf-client-connection-ip"]).toBe("203.0.113.50");
    expect(headers["x-real-ip"]).toBe("203.0.113.50");
  });

  it("does not overwrite pre-existing netlify headers", async () => {
    runner = new NetlifyEnvRunner({ name: "test-no-overwrite", data: { entry: headersEntry } });
    await runner.waitForReady();
    const res = await runner.fetch(
      new Request("http://localhost/", {
        headers: {
          "x-nf-client-connection-ip": "10.0.0.1",
          "x-nf-site-id": "my-site",
          "x-nf-deploy-context": "production",
        },
      }),
    );
    const headers = await res.json();
    expect(headers["x-nf-client-connection-ip"]).toBe("10.0.0.1");
    expect(headers["x-nf-site-id"]).toBe("my-site");
    expect(headers["x-nf-deploy-context"]).toBe("production");
  });
});
