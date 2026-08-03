import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from "vitest";
import { serve } from "srvx";
import type { Server } from "srvx";
import { VercelEnvRunner } from "../src/runners/vercel/runner.ts";

// Fake unsigned JWT with a far-future `exp` to silence the Vercel OIDC token warning
const fakeVercelOidcToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.x`;

const _dir = dirname(fileURLToPath(import.meta.url));
const headersEntry = resolve(_dir, "./fixtures/app-headers.mjs");
const envEntry = resolve(_dir, "./fixtures/app-env.mjs");
const appEntry = resolve(_dir, "./fixtures/app.mjs");
const imageEntry = resolve(_dir, "./fixtures/app-image.mjs");

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

  // `cli.ts` hands the front server's own request object straight to `fetch()`.
  // srvx's request passes `instanceof Request` but the undici `Request`
  // constructor refuses to clone it, so `fetch()` must forward it untouched.
  describe("host-runtime request objects", () => {
    let server: Server | undefined;

    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    it("forwards a srvx request without re-wrapping it", async () => {
      runner = new VercelEnvRunner({ name: "test-srvx-req", data: { entry: headersEntry } });
      await runner.waitForReady();

      server = serve({
        port: 0,
        hostname: "127.0.0.1",
        gracefulShutdown: false,
        fetch: (request) => runner!.fetch(request),
      });
      await server.ready();

      const res = await fetch(new URL("/", server.url));
      expect(res.status).toBe(200);
      // The injected headers still reach the worker through `proxyFetch()`
      const headers = await res.json();
      expect(headers["x-vercel-id"]).toMatch(/^dev1::/);
      expect(headers["x-vercel-deployment-url"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("forwards a srvx request to the image handler", async () => {
      runner = new VercelEnvRunner({ name: "test-srvx-img", data: { entry: imageEntry } });
      await runner.waitForReady();

      server = serve({
        port: 0,
        hostname: "127.0.0.1",
        gracefulShutdown: false,
        fetch: (request) => runner!.fetch(request),
      });
      await server.ready();

      const res = await fetch(new URL("/_vercel/image?url=/test.png&w=1&q=75", server.url));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
    });
  });

  // Wiring only — the handler's own validation/optimization matrix lives in
  // `test/vercel-image.test.ts`, which runs without spawning a worker.
  describe("image optimization", () => {
    it("optimizes a local source served by the worker", async () => {
      runner = new VercelEnvRunner({ name: "test-img", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
      expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    });

    it("injects the Vercel response headers on image responses", async () => {
      runner = new VercelEnvRunner({ name: "test-img-headers", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.headers.get("server")).toBe("Vercel");
      expect(res.headers.get("x-vercel-id")).toMatch(/^dev1::/);
      expect(res.headers.get("x-vercel-cache")).toBe("MISS");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
      expect(res.headers.get("vary")).toBe("Accept");
    });

    it("forwards request headers to the handler", async () => {
      runner = new VercelEnvRunner({ name: "test-img-accept", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch(
        new Request("http://localhost/_vercel/image?url=/test.png&w=1&q=75", {
          headers: { accept: "image/webp,image/png,*/*" },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    });

    it("preserves the request method", async () => {
      runner = new VercelEnvRunner({ name: "test-img-head", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch(
        new Request("http://localhost/_vercel/image?url=/test.png&w=1&q=75", { method: "HEAD" }),
      );
      expect(res.status).toBe(200);
      expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
    });

    it("passes the images config through to the handler", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-sizes",
        data: { entry: imageEntry },
        images: { sizes: [64, 128, 256] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=100&q=75");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"w" must be one of: 64, 128, 256');
    });

    it("propagates handler errors with the Vercel response headers", async () => {
      runner = new VercelEnvRunner({ name: "test-img-nourl", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?w=100&q=75");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is required');
      expect(res.headers.get("server")).toBe("Vercel");
    });

    it("revalidates with if-none-match end to end", async () => {
      runner = new VercelEnvRunner({ name: "test-img-etag", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();

      const revalidated = await runner.fetch(
        new Request("http://localhost/_vercel/image?url=/test.png&w=1&q=75", {
          headers: { "if-none-match": etag! },
        }),
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    });
  });
});
