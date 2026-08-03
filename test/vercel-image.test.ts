import type { AddressInfo } from "node:net";

import { createServer, type Server } from "node:http";
import { serve } from "srvx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createVercelImageHandler,
  type VercelImageConfig,
  type VercelImageHandler,
} from "../src/runners/vercel/image.ts";

// Minimal 1x1 red PNG
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>`,
);

/**
 * Stands in for the worker: `getAddress()` points at it, and it doubles as a
 * "remote" origin for the `domains`/`remotePatterns`/`blockPrivateIPs` tests.
 */
let origin: Server;
let port: number;

beforeAll(async () => {
  origin = createServer((req, res) => {
    // Decoded so a path with percent-encoded characters (see the
    // content-disposition escaping test) is matched by its literal form
    const path = decodeURIComponent((req.url || "").split("?")[0]!);
    if (path === '/od"d.png') {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(req.method === "HEAD" ? undefined : PNG_1x1);
    } else if (path === "/test.png" || path === "/assets/test.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(req.method === "HEAD" ? undefined : PNG_1x1);
    } else if (path === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(req.method === "HEAD" ? undefined : SVG);
    } else if (path === "/note.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "not an image");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => origin.close(r));
});

function makeHandler(config?: VercelImageConfig): VercelImageHandler {
  return createVercelImageHandler({
    getAddress: () => ({ host: "127.0.0.1", port }),
    config,
  });
}

function get(
  handler: VercelImageHandler,
  query: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return handler.handle(new Request(`http://localhost/_vercel/image?${query}`, { headers }));
}

describe("createVercelImageHandler", () => {
  describe("request method", () => {
    it("serves GET and HEAD", async () => {
      for (const method of ["GET", "HEAD"]) {
        const res = await makeHandler().handle(
          new Request("http://localhost/_vercel/image?url=/test.png&w=8", { method }),
        );
        expect(res.status).toBe(200);
      }
    });

    it.each(["POST", "PUT", "DELETE"])("rejects %s with 405", async (method) => {
      const res = await makeHandler().handle(
        new Request("http://localhost/_vercel/image?url=/test.png&w=8", { method }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    });
  });

  describe("worker address", () => {
    // `createVercelImageHandler()` is public API, so `getAddress` may return an
    // address the handler can't reach over HTTP
    const socketAddress = () => ({ socketPath: "/tmp/env-runner.sock" }) as never;

    it("rejects a unix socket address for a local source", async () => {
      const handler = createVercelImageHandler({ getAddress: socketAddress });
      const res = await get(handler, "url=/test.png&w=8");
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("unix sockets are not supported");
    });

    it("still serves a remote source with a socket address", async () => {
      // A remote source never touches the worker, so the guard must not apply
      const handler = createVercelImageHandler({
        getAddress: socketAddress,
        config: { domains: ["127.0.0.1"], blockPrivateIPs: false },
      });
      const res = await get(
        handler,
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("parameter validation", () => {
    it("requires the url parameter", async () => {
      const res = await get(makeHandler(), "w=64");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is required');
    });

    it("requires the w parameter", async () => {
      const res = await get(makeHandler(), "url=/test.png");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"w" parameter is required');
    });

    it.each(["abc", "0", "-64", "8abc", "0x10", "1e3"])("rejects w=%s", async (w) => {
      const res = await get(makeHandler(), `url=/test.png&w=${w}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"w" must be a positive integer');
    });

    it.each(["0", "101", "abc", "75abc", "-5"])("rejects q=%s", async (q) => {
      const res = await get(makeHandler(), `url=/test.png&w=8&q=${q}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"q" must be between 1 and 100');
    });

    it("rejects a width outside the configured sizes", async () => {
      const res = await get(makeHandler({ sizes: [64, 128] }), "url=/test.png&w=100");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"w" must be one of: 64, 128');
    });

    it("rejects a quality outside the configured qualities", async () => {
      const res = await get(makeHandler({ qualities: [50, 100] }), "url=/test.png&w=8&q=60");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"q" must be one of: 50, 100');
    });

    it("snaps an omitted q to the nearest configured quality", async () => {
      // A hard default of 75 would be rejected by this `qualities` list
      const res = await get(makeHandler({ qualities: [50, 100] }), "url=/test.png&w=8");
      expect(res.status).toBe(200);
    });

    it("rejects a format outside the configured formats", async () => {
      const res = await get(
        makeHandler({ formats: ["image/webp"] }),
        "url=/test.png&w=8&f=image/avif",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"f" must be one of: image/webp');
    });

    it("compares f against formats without the image/ prefix", async () => {
      // `f=webp` and `f=image/webp` must both satisfy `formats: ["image/webp"]`
      for (const f of ["webp", "image/webp"]) {
        const res = await get(makeHandler({ formats: ["image/webp"] }), `url=/test.png&w=8&f=${f}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/webp");
      }
    });

    it.each(["//evil.example/x.png", "data:image/png;base64,AAAA", "ftp://x.example/a.png"])(
      "rejects a non-local, non-http url (%s)",
      async (url) => {
        const res = await get(makeHandler(), `url=${encodeURIComponent(url)}&w=8`);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('"url" parameter is not allowed');
      },
    );
  });

  describe("remote source allowlist", () => {
    it("denies remote sources when nothing is configured", async () => {
      const res = await get(makeHandler(), "url=https://cdn.example/a.png&w=8");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
    });

    it("allows a remote source matching domains", async () => {
      const res = await get(
        makeHandler({ domains: ["127.0.0.1"], blockPrivateIPs: false }),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
    });

    it("denies a remote source not matching domains", async () => {
      const res = await get(
        makeHandler({ domains: ["allowed.example"] }),
        "url=https://evil.example/a.png&w=8",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
    });

    it("matches remotePatterns in glob form", async () => {
      const config: VercelImageConfig = {
        remotePatterns: [{ protocol: "http", hostname: "127.0.0.1", pathname: "/assets/**" }],
        blockPrivateIPs: false,
      };
      const denied = await get(
        makeHandler(config),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(denied.status).toBe(400);
      expect(await denied.text()).toBe('"url" parameter is not allowed');

      const allowed = await get(
        makeHandler(config),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/assets/test.png`)}&w=8`,
      );
      expect(allowed.status).toBe(200);
    });

    it("matches remotePatterns in Build Output API regex form", async () => {
      const config: VercelImageConfig = {
        remotePatterns: [
          { protocol: "http", hostname: "^127\\.0\\.0\\.1$", pathname: "^/assets/.*$" },
        ],
        blockPrivateIPs: false,
      };
      const denied = await get(
        makeHandler(config),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(denied.status).toBe(400);

      const allowed = await get(
        makeHandler(config),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/assets/test.png`)}&w=8`,
      );
      expect(allowed.status).toBe(200);
    });

    it("blocks private IPs by default", async () => {
      const res = await get(
        makeHandler({ domains: ["127.0.0.1"] }),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(res.status).toBe(403);
      // ipx's own `IPX_FORBIDDEN_IP` JSON is re-stated as the endpoint's message
      expect(await res.text()).toBe('"url" parameter is not allowed');
    });
  });

  describe("local source allowlist", () => {
    it("allows any local path when localPatterns is unset", async () => {
      const res = await get(makeHandler(), "url=/test.png&w=8");
      expect(res.status).toBe(200);
    });

    it("allows a local path matching localPatterns", async () => {
      const res = await get(
        makeHandler({ localPatterns: [{ pathname: "/assets/**" }] }),
        "url=/assets/test.png&w=8",
      );
      expect(res.status).toBe(200);
    });

    it("denies a local path not matching localPatterns", async () => {
      const res = await get(
        makeHandler({ localPatterns: [{ pathname: "/assets/**" }] }),
        "url=/test.png&w=8",
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
    });
  });

  describe("svg", () => {
    it("blocks svg sources by default", async () => {
      const res = await get(makeHandler(), "url=/icon.svg&w=8");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is valid but image type is not allowed');
    });

    it("serves svg when dangerouslyAllowSVG is set", async () => {
      const res = await get(makeHandler({ dangerouslyAllowSVG: true }), "url=/icon.svg&w=8");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("content-security-policy")).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
    });
  });

  describe("response headers", () => {
    it("derives cache-control from minimumCacheTTL", async () => {
      const res = await get(makeHandler({ minimumCacheTTL: 120 }), "url=/test.png&w=8");
      expect(res.headers.get("cache-control")).toBe("public, max-age=120, s-maxage=120");
    });

    it("sets nosniff, Vary and content-length", async () => {
      const res = await get(makeHandler(), "url=/test.png&w=8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("vary")).toBe("Accept");
      expect(Number(res.headers.get("content-length"))).toBe((await res.arrayBuffer()).byteLength);
    });

    it("sets a baseline CSP", async () => {
      const res = await get(makeHandler(), "url=/test.png&w=8");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    });

    it("sets content-disposition when configured", async () => {
      const res = await get(
        makeHandler({ contentDispositionType: "attachment" }),
        "url=/test.png&w=8",
      );
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="test.png"');
    });

    it("strips quotes from the content-disposition filename", async () => {
      // An unescaped `"` would terminate the quoted filename and mangle the header
      const res = await get(
        makeHandler({ contentDispositionType: "attachment" }),
        `url=${encodeURIComponent('/od"d.png')}&w=8`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="odd.png"');
    });

    it("revalidates with if-none-match", async () => {
      const handler = makeHandler();
      const first = await get(handler, "url=/test.png&w=8");
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await get(handler, "url=/test.png&w=8", { "if-none-match": etag! });
      expect(second.status).toBe(304);
      expect(second.headers.get("cache-control")).toBeTruthy();
    });
  });

  describe("format negotiation", () => {
    it("negotiates from a host-runtime request object", async () => {
      // The request reaches ipx unwrapped, so a framework mounting the handler on its
      // own server passes that server's request class straight through
      const handler = makeHandler();
      const front = serve({
        port: 0,
        hostname: "127.0.0.1",
        gracefulShutdown: false,
        fetch: (request) => handler.handle(request),
      });
      await front.ready();
      try {
        const res = await fetch(new URL("/_vercel/image?url=/test.png&w=8", front.url), {
          headers: { accept: "image/avif,image/webp,*/*" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/avif");
      } finally {
        await front.close();
      }
    });

    it("prefers avif over webp from the Accept header", async () => {
      const res = await get(makeHandler(), "url=/test.png&w=8", {
        accept: "image/avif,image/webp,*/*",
      });
      expect(res.headers.get("content-type")).toBe("image/avif");
    });

    it("skips formats excluded by config", async () => {
      const res = await get(makeHandler({ formats: ["image/webp"] }), "url=/test.png&w=8", {
        accept: "image/avif,image/webp,*/*",
      });
      expect(res.headers.get("content-type")).toBe("image/webp");
    });

    it("keeps the source format when Accept offers nothing better", async () => {
      const res = await get(makeHandler(), "url=/test.png&w=8", { accept: "image/png,*/*" });
      expect(res.headers.get("content-type")).toBe("image/png");
    });
  });

  // ipx's own JSON error bodies name its `IPX_*` codes and the resolved source path.
  // The statuses are kept; the bodies are re-stated to match the fallback path.
  describe("upstream failures", () => {
    it("returns 404 for a missing local source", async () => {
      const res = await get(makeHandler(), "url=/missing.png&w=8");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('"url" parameter is valid but upstream response is invalid');
    });

    it("returns 400 for an undecodable source", async () => {
      const res = await get(makeHandler(), "url=/note.txt&w=8");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is valid but upstream is not an image');
    });

    it("returns 404 before the runner reports an address", async () => {
      // The worker storage yields nothing, which ipx reports as a missing source
      const handler = createVercelImageHandler({ getAddress: () => undefined });
      const res = await handler.handle(
        new Request("http://localhost/_vercel/image?url=/test.png&w=8"),
      );
      expect(res.status).toBe(404);
    });
  });
});

describe("createVercelImageHandler without ipx", () => {
  beforeAll(() => {
    vi.resetModules();
    vi.doMock("ipx", () => {
      throw new Error("Cannot find package 'ipx'");
    });
  });

  afterAll(() => {
    vi.doUnmock("ipx");
    vi.resetModules();
  });

  async function makeBareHandler(config?: VercelImageConfig) {
    // Re-imported so the module-level ipx load state is re-evaluated under the mock
    const { createVercelImageHandler: create } = await import("../src/runners/vercel/image.ts");
    return create({ getAddress: () => ({ host: "127.0.0.1", port }), config });
  }

  it("proxies the unoptimized source and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = await makeBareHandler();

    const res = await get(handler, "url=/test.png&w=8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ipx is not installed"));

    await get(handler, "url=/test.png&w=8");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still validates before proxying", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=https://cdn.example/a.png&w=8");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('"url" parameter is not allowed');
  });

  it("rejects a non-image upstream", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/note.txt&w=8");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('"url" parameter is valid but upstream is not an image');
  });

  it("forwards the upstream status for a missing source", async () => {
    // Not a content-type problem, so it must not be reported as "not an image"
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/missing.png&w=8");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('"url" parameter is valid but upstream response is invalid');
  });

  it("reports an unreachable upstream as 502", async () => {
    const { createVercelImageHandler: create } = await import("../src/runners/vercel/image.ts");
    // Port 1 is reserved, so the connection is refused rather than timing out
    const handler = create({ getAddress: () => ({ host: "127.0.0.1", port: 1 }) });
    const res = await get(handler, "url=/test.png&w=8");
    expect(res.status).toBe(502);
  });

  it("sets a baseline CSP on the fallback path too", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/test.png&w=8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("rejects non-GET/HEAD before touching the upstream", async () => {
    const handler = await makeBareHandler();
    const res = await handler.handle(
      new Request("http://localhost/_vercel/image?url=/test.png&w=8", { method: "POST" }),
    );
    expect(res.status).toBe(405);
  });

  it("returns 503 before the runner reports an address", async () => {
    const { createVercelImageHandler: create } = await import("../src/runners/vercel/image.ts");
    const handler = create({ getAddress: () => undefined });
    const res = await handler.handle(
      new Request("http://localhost/_vercel/image?url=/test.png&w=8"),
    );
    expect(res.status).toBe(503);
  });
});
