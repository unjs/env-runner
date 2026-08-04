import type { AddressInfo } from "node:net";

import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
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
    if (path === '/od"d.png' || path === "/日本.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(req.method === "HEAD" ? undefined : PNG_1x1);
    } else if (path === "/gzipped.png") {
      // `fetch` decodes this before the fallback path sees it, so the upstream
      // `content-encoding`/`content-length` no longer describe the served body
      const gz = gzipSync(PNG_1x1);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-encoding": "gzip",
        "content-length": String(gz.length),
        "set-cookie": "sid=abc; Path=/",
      });
      res.end(req.method === "HEAD" ? undefined : gz);
    } else if (path === "/notmodified.png") {
      // A worker answering an unconditional request with 304
      res.writeHead(304).end();
    } else if (path === "/test.png" || path === "/assets/test.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(req.method === "HEAD" ? undefined : PNG_1x1);
    } else if (path === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(req.method === "HEAD" ? undefined : SVG);
    } else if (path === "/note.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "not an image");
    } else if (path === "/redirect.png") {
      // Stands in for an allowlisted host bouncing the fetch elsewhere
      res.writeHead(302, { location: `http://127.0.0.1:${port}/test.png` });
      res.end();
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

    // The deployed endpoint honors `url`, `w` and `q` and ignores everything else —
    // verified against a Vercel-hosted `/_vercel/image`, where `f=image/webp` under
    // `accept: image/png` still returns PNG. Anything that pinned the format here
    // would be a dev-only transform that vanishes in production.
    it.each(["f=image/webp", "f=webp", "h=8", "fit=cover", "blur=5", "unknown=1"])(
      "ignores %s",
      async (param) => {
        const res = await get(makeHandler(), `url=/test.png&w=8&${param}`, {
          accept: "image/png,*/*",
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
      },
    );

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

    // The pattern is matched against the normalized path, not the raw string:
    // `/assets/../test.png` lexically satisfies `/assets/**` but resolves to
    // `/test.png` once fetched, which the same config denies outright
    it("denies a traversal that escapes localPatterns", async () => {
      const res = await get(
        makeHandler({ localPatterns: [{ pathname: "/assets/**" }] }),
        `url=${encodeURIComponent("/assets/../test.png")}&w=8`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
    });

    // Everything after the *first* `?` is the query, so a `search` rule cannot be
    // satisfied by the first of two query strings
    it("denies a search that only matches up to a second ?", async () => {
      const config: VercelImageConfig = {
        localPatterns: [{ pathname: "/test.png", search: "?v=1" }],
      };
      const allowed = await get(
        makeHandler(config),
        `url=${encodeURIComponent("/test.png?v=1")}&w=8`,
      );
      expect(allowed.status).toBe(200);

      const denied = await get(
        makeHandler(config),
        `url=${encodeURIComponent("/test.png?v=1?evil=2")}&w=8`,
      );
      expect(denied.status).toBe(400);
      expect(await denied.text()).toBe('"url" parameter is not allowed');
    });
  });

  describe("malformed config patterns", () => {
    // A `SyntaxError` from `new RegExp()` used to escape `handle()` here, since
    // `validateLocalUrl()` has no `catch` of its own — every request for that
    // config then failed as an unhandled throw rather than a `Response`.
    it("denies rather than throwing on an invalid localPatterns regex", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handler = makeHandler({ localPatterns: [{ pathname: "^/assets/[a-z$" }] });

      const res = await get(handler, "url=/assets/test.png&w=8");
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid Vercel image pattern"));

      // Compiled patterns are cached, so the warning is not repeated per request
      await get(handler, "url=/assets/test.png&w=8");
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    // `validateRemoteUrl()`'s `catch` already turned this into a deny, but silently
    // — the warning is what makes a typo'd pattern diagnosable rather than a
    // mystery "not allowed" on every remote image.
    it("warns and denies on an invalid remotePatterns regex", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await get(
        makeHandler({ remotePatterns: [{ hostname: "^127\\.0\\.[a-z$" }] }),
        `url=${encodeURIComponent(`http://127.0.0.1:${port}/test.png`)}&w=8`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('"url" parameter is not allowed');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid Vercel image pattern"));
      warn.mockRestore();
    });

    it("still matches the valid patterns alongside an invalid one", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await get(
        makeHandler({ localPatterns: [{ pathname: "^/bad/[a-z$" }, { pathname: "/assets/**" }] }),
        "url=/assets/test.png&w=8",
      );
      expect(res.status).toBe(200);
      warn.mockRestore();
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

    // ipx nulls the body for HEAD while keeping the length it computed from the
    // full image; buffering that empty body would report `content-length: 0`.
    it("keeps the real content-length on a HEAD request", async () => {
      const handler = makeHandler();
      const expected = Number(
        (await get(handler, "url=/test.png&w=8")).headers.get("content-length"),
      );
      expect(expected).toBeGreaterThan(0);

      const res = await handler.handle(
        new Request("http://localhost/_vercel/image?url=/test.png&w=8", { method: "HEAD" }),
      );
      expect(res.status).toBe(200);
      expect(Number(res.headers.get("content-length"))).toBe(expected);
      expect(await res.text()).toBe("");
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

    // A raw non-Latin1 filename cannot go in a header value at all: `Headers.set()`
    // throws, and that `TypeError` used to escape `handle()` entirely
    it.each([
      ["local", () => `url=${encodeURIComponent("/日本.png")}&w=8`],
      ["remote", () => `url=${encodeURIComponent(`http://127.0.0.1:${port}/日本.png`)}&w=8`],
    ])("carries a non-ASCII %s filename in filename*", async (_kind, query) => {
      const res = await get(
        makeHandler({
          contentDispositionType: "attachment",
          domains: ["127.0.0.1"],
          blockPrivateIPs: false,
        }),
        query(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="__.png"; filename*=UTF-8''${encodeURIComponent("日本.png")}`,
      );
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

  // The allowlist gates only the requested URL, so following a redirect would let
  // an allowlisted host serve an unvalidated address under the app's origin. The
  // ipx path re-validates each hop; this path refuses them instead.
  it("refuses to follow a redirect from a remote source", async () => {
    const handler = await makeBareHandler({ domains: ["127.0.0.1"] });
    const res = await get(
      handler,
      `url=${encodeURIComponent(`http://127.0.0.1:${port}/redirect.png`)}&w=8`,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('"url" parameter is valid but upstream response is invalid');
  });

  it("still follows a redirect from a local source", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/redirect.png&w=8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  // `fetch` has already decoded the body by the time it is re-served, so forwarding
  // the upstream `content-encoding` left the client unable to decode it
  it("drops content-encoding and the stale content-length", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/gzipped.png&w=8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(PNG_1x1.byteLength);
    const length = res.headers.get("content-length");
    if (length !== null) expect(Number(length)).toBe(body.byteLength);
  });

  it("does not forward set-cookie from the upstream", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/gzipped.png&w=8");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  // `new Response(body, { status: 304 })` throws, so the status cannot be reused
  it("reports an upstream 304 as 502 rather than throwing", async () => {
    const handler = await makeBareHandler();
    const res = await get(handler, "url=/notmodified.png&w=8");
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('"url" parameter is valid but upstream response is invalid');
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
