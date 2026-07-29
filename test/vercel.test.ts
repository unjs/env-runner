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

  // /_vercel/image optimization tests
  describe("image optimization", () => {
    it("returns optimized image for local source", async () => {
      runner = new VercelEnvRunner({ name: "test-img", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
    });

    it("returns correct format when f param is provided", async () => {
      runner = new VercelEnvRunner({ name: "test-img-fmt", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch(
        "http://localhost/_vercel/image?url=/test.png&w=1&q=75&f=image/webp",
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    });

    it("auto-detects format from Accept header", async () => {
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

    it("returns 400 for missing url param", async () => {
      runner = new VercelEnvRunner({ name: "test-img-nourl", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?w=100&q=75");
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing w param", async () => {
      runner = new VercelEnvRunner({ name: "test-img-now", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&q=75");
      expect(res.status).toBe(400);
    });

    it("includes vercel response headers on image responses", async () => {
      runner = new VercelEnvRunner({ name: "test-img-headers", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.headers.get("server")).toBe("Vercel");
      expect(res.headers.get("x-vercel-id")).toMatch(/^dev1::/);
      expect(res.headers.get("x-vercel-cache")).toBe("MISS");
    });

    it("sets cache-control header", async () => {
      runner = new VercelEnvRunner({ name: "test-img-cache", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    });

    it("sets Vary: Accept header for format negotiation", async () => {
      runner = new VercelEnvRunner({ name: "test-img-vary", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      expect(res.headers.get("vary")).toBe("Accept");
    });

    it("sets Content-Length header", async () => {
      runner = new VercelEnvRunner({ name: "test-img-cl", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=75");
      const cl = res.headers.get("content-length");
      expect(cl).toBeTruthy();
      expect(Number(cl)).toBeGreaterThan(0);
    });

    it("blocks SVG sources by default", async () => {
      runner = new VercelEnvRunner({ name: "test-img-svg", data: { entry: imageEntry } });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/icon.svg&w=100&q=75");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("image type is not allowed");
    });

    it("allows SVG when dangerouslyAllowSVG is true", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-svg-allow",
        data: { entry: imageEntry },
        images: { dangerouslyAllowSVG: true },
      });
      await runner.waitForReady();
      // The fixture doesn't actually serve SVG, but validation should pass
      // (will fail at IPX level, not at our validation)
      const res = await runner.fetch("http://localhost/_vercel/image?url=/icon.svg&w=100&q=75");
      // Should not be 400 "image type is not allowed"
      expect(await res.text()).not.toContain("image type is not allowed");
    });

    it("returns 400 for disallowed remote URL when domains configured", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-remote-blocked",
        data: { entry: imageEntry },
        images: { domains: ["allowed.invalid"] },
      });
      await runner.waitForReady();
      const res = await runner.fetch(
        "http://localhost/_vercel/image?url=https://evil.invalid/img.png&w=100&q=75",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('"url" parameter is not allowed');
    });

    it("allows remote URL when domain matches", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-remote-allowed",
        data: { entry: imageEntry },
        images: { domains: ["allowed.invalid"] },
      });
      await runner.waitForReady();
      // Will pass validation but fail to fetch (no such host)
      const res = await runner.fetch(
        "http://localhost/_vercel/image?url=https://allowed.invalid/img.png&w=100&q=75",
      );
      // Should NOT be 400 "url parameter is not allowed"
      expect(await res.text()).not.toContain('"url" parameter is not allowed');
    });

    it("validates against remotePatterns (glob format)", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-remote-pattern",
        data: { entry: imageEntry },
        images: {
          remotePatterns: [{ protocol: "https", hostname: "cdn.invalid" }],
        },
      });
      await runner.waitForReady();

      // Blocked: different hostname
      const blocked = await runner.fetch(
        "http://localhost/_vercel/image?url=https://other.invalid/img.png&w=100&q=75",
      );
      expect(blocked.status).toBe(400);

      // Allowed: matching pattern (will fail to fetch but passes validation)
      const allowed = await runner.fetch(
        "http://localhost/_vercel/image?url=https://cdn.invalid/img.png&w=100&q=75",
      );
      expect(await allowed.text()).not.toContain('"url" parameter is not allowed');
    });

    it("validates against remotePatterns (Build Output API regex format)", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-remote-regex",
        data: { entry: imageEntry },
        images: {
          remotePatterns: [
            {
              protocol: "https",
              hostname: "^cdn\\.invalid$",
              pathname: "^/assets/.*$",
            },
          ],
        },
      });
      await runner.waitForReady();

      // Blocked: wrong hostname
      const blocked1 = await runner.fetch(
        "http://localhost/_vercel/image?url=https://other.invalid/assets/img.png&w=100&q=75",
      );
      expect(blocked1.status).toBe(400);
      expect(await blocked1.text()).toContain('"url" parameter is not allowed');

      // Blocked: wrong pathname
      const blocked2 = await runner.fetch(
        "http://localhost/_vercel/image?url=https://cdn.invalid/other/img.png&w=100&q=75",
      );
      expect(blocked2.status).toBe(400);

      // Allowed: matches regex pattern (will fail to fetch but passes validation)
      const allowed = await runner.fetch(
        "http://localhost/_vercel/image?url=https://cdn.invalid/assets/img.png&w=100&q=75",
      );
      expect(await allowed.text()).not.toContain('"url" parameter is not allowed');
    });

    it("returns 400 for width not in configured sizes", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-sizes",
        data: { entry: imageEntry },
        images: { sizes: [64, 128, 256] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=100&q=75");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('"w" must be one of');
    });

    it("returns 400 for quality not in configured qualities", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-qualities",
        data: { entry: imageEntry },
        images: { qualities: [50, 75, 100] },
      });
      await runner.waitForReady();
      const res = await runner.fetch("http://localhost/_vercel/image?url=/test.png&w=1&q=60");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('"q" must be one of');
    });

    it("allows remote images when no domain restrictions configured", async () => {
      runner = new VercelEnvRunner({
        name: "test-img-remote-open",
        data: { entry: imageEntry },
      });
      await runner.waitForReady();
      // No domains/remotePatterns = allow all (will fail to actually fetch)
      const res = await runner.fetch(
        "http://localhost/_vercel/image?url=https://any.invalid/img.png&w=100&q=75",
      );
      expect(await res.text()).not.toContain('"url" parameter is not allowed');
    });
  });
});
