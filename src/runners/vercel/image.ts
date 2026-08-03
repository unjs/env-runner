import type { WorkerAddress } from "../../types.ts";

export interface VercelRemotePattern {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
}

export interface VercelLocalPattern {
  pathname?: string;
  search?: string;
}

export interface VercelImageConfig {
  sizes?: number[];
  domains?: string[];
  remotePatterns?: VercelRemotePattern[];
  localPatterns?: VercelLocalPattern[];
  qualities?: number[];
  formats?: string[];
  minimumCacheTTL?: number;
  dangerouslyAllowSVG?: boolean;
  contentSecurityPolicy?: string;
  contentDispositionType?: string;

  /**
   * env-runner extension (not part of the Vercel `images` config): reject remote
   * sources that are, or resolve to, a non-public IP address. Only applies to
   * remote sources — local paths are always served through the worker.
   *
   * @default true
   */
  blockPrivateIPs?: boolean;
}

const DEFAULT_MAX_AGE = 60;
const DEFAULT_QUALITY = 75;

type IPXModule = typeof import("ipx");

let _ipxModule: IPXModule | undefined;
let _ipxLoaded = false;

async function loadIPX(): Promise<IPXModule | undefined> {
  if (_ipxLoaded) return _ipxModule;
  _ipxLoaded = true;
  try {
    _ipxModule = await import("ipx");
  } catch {
    console.warn(
      "ipx is not installed. Install it for Vercel image optimization: npx nypm i -D ipx",
    );
  }
  return _ipxModule;
}

// `VercelEnvRunner` extends `NodeWorkerEnvRunner`, which always listens on TCP
function resolveWorkerUrl(address: WorkerAddress, path: string): string {
  return `http://${address.host || "127.0.0.1"}:${address.port}${path}`;
}

const SOCKET_ADDRESS_MESSAGE =
  "Vercel image handler requires a TCP worker address (host/port); unix sockets are not supported.";

// `VercelEnvRunner` always listens on TCP, but `createVercelImageHandler()` is public
// API taking an arbitrary `getAddress`. Checked up front for local sources so a socket
// address fails loudly instead of building `http://undefined:undefined/...`, whose
// failed fetch would otherwise surface as a misleading 404 "resource not found".
function rejectSocketAddress(address: WorkerAddress | undefined): Response | undefined {
  return address?.socketPath ? new Response(SOCKET_ADDRESS_MESSAGE, { status: 500 }) : undefined;
}

// --- URL validation ---

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

// Build Output API uses PCRE regex (^...$), Next.js config uses globs (**, *).
// Patterns come from config and are re-tested on every request, so compile once.
const _patternCache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
  let compiled = _patternCache.get(pattern);
  if (compiled) return compiled;
  if (pattern.startsWith("^") && pattern.endsWith("$")) {
    compiled = new RegExp(pattern);
  } else {
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern.charAt(i);
      if (ch === "*" && pattern.charAt(i + 1) === "*") {
        re += ".*";
        i++;
      } else if (ch === "*") {
        re += "[^/]*";
      } else if (".+?{}()[]\\^$|".includes(ch)) {
        re += "\\" + ch;
      } else {
        re += ch;
      }
    }
    compiled = new RegExp(re + "$");
  }
  _patternCache.set(pattern, compiled);
  return compiled;
}

function matchPattern(pattern: string, value: string): boolean {
  return patternToRegExp(pattern).test(value);
}

function matchRemotePattern(pattern: VercelRemotePattern, url: URL): boolean {
  if (pattern.protocol && url.protocol !== pattern.protocol + ":") return false;
  if (!matchPattern(pattern.hostname, url.hostname)) return false;
  if (pattern.port !== undefined && url.port !== pattern.port) return false;
  if (pattern.pathname && !matchPattern(pattern.pathname, url.pathname)) return false;
  if (pattern.search !== undefined && url.search !== pattern.search) return false;
  return true;
}

// A remote source is only optimized when it is covered by `domains` or `remotePatterns`.
function validateRemoteUrl(sourceUrl: string, config?: VercelImageConfig): boolean {
  if (!config?.domains?.length && !config?.remotePatterns?.length) {
    return false;
  }
  try {
    const parsed = new URL(sourceUrl);
    if (config.domains?.includes(parsed.hostname)) return true;
    if (config.remotePatterns?.some((p) => matchRemotePattern(p, parsed))) return true;
  } catch {}
  return false;
}

function validateLocalUrl(sourceUrl: string, config?: VercelImageConfig): boolean {
  if (!config?.localPatterns?.length) return true;
  const [pathname = "", search] = sourceUrl.split("?");
  return config.localPatterns.some((p) => {
    if (p.pathname && !matchPattern(p.pathname, pathname)) return false;
    if (p.search !== undefined && (search || "") !== p.search.replace(/^\?/, "")) return false;
    return true;
  });
}

// ipx re-validates every redirect hop against its own `domains` allowlist, which is
// only possible with literal hostnames. Returns undefined when the config uses globs
// or Build Output API regexes, in which case ipx runs with `allowAllDomains` and the
// initial URL is gated by `validateRemoteUrl()` above.
function literalHostnames(config?: VercelImageConfig): string[] | undefined {
  const hostnames = [...(config?.domains || [])];
  for (const pattern of config?.remotePatterns || []) {
    if (!pattern.hostname || /[*^$?[\]{}()|+\\]/.test(pattern.hostname)) return undefined;
    hostnames.push(pattern.hostname);
  }
  return hostnames.length > 0 ? hostnames : undefined;
}

function isSvgSource(url: string): boolean {
  const path = url.startsWith("/")
    ? url
    : (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })();
  return /\.svgz?(\?|$)/i.test(path);
}

function ensureVaryAccept(headers: Headers): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", "Accept");
  } else if (!/(^|,\s*)Accept(\s*,|\s*$)/i.test(existing)) {
    headers.set("vary", `${existing}, Accept`);
  }
}

function applySecurityHeaders(
  headers: Headers,
  sourceUrl: string,
  config?: VercelImageConfig,
): void {
  // Crafted image files can be sniffed as HTML
  headers.set("x-content-type-options", "nosniff");
  if (config?.contentSecurityPolicy) {
    headers.set("content-security-policy", config.contentSecurityPolicy);
  } else if (config?.dangerouslyAllowSVG) {
    // Match Next.js default CSP when SVGs are allowed
    headers.set("content-security-policy", "script-src 'none'; frame-src 'none'; sandbox;");
  } else if (!headers.has("content-security-policy")) {
    // ipx sets this on its own responses; setting it here too keeps the
    // unoptimized fallback from being the weaker path.
    headers.set("content-security-policy", "default-src 'none'");
  }
  if (config?.contentDispositionType) {
    // Quotes and backslashes are stripped rather than escaped: they would
    // otherwise terminate the quoted `filename` and mangle the whole header.
    const filename = sourceUrl.split("/").pop()?.split("?")[0]?.replaceAll(/["\\]/g, "") || "image";
    headers.set("content-disposition", `${config.contentDispositionType}; filename="${filename}"`);
  }
}

// --- Request parsing ---

interface ParsedImageRequest {
  sourceUrl: string;
  modifiers: Record<string, string | number>;
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

/** Strips the `image/` prefix so `f=webp` and `f=image/webp` compare equal. */
function bareFormat(format: string): string {
  return format.replace(/^image\//, "");
}

function nearestQuality(target: number, qualities?: number[]): number {
  if (!qualities?.length) return target;
  return qualities.reduce((best, q) => (Math.abs(q - target) < Math.abs(best - target) ? q : best));
}

function negotiateFormat(accept: string, allowed?: string[]): string | undefined {
  const isAllowed = (fmt: string) => !allowed?.length || allowed.includes(fmt);
  if (accept.includes("image/avif") && isAllowed("avif")) return "avif";
  if (accept.includes("image/webp") && isAllowed("webp")) return "webp";
  return undefined;
}

// ipx answers failures with JSON carrying its own `IPX_*` codes and the resolved
// source path. Its statuses are right, so keep them and re-state the body with the
// plain-text message the rest of the endpoint uses.
const IPX_ERROR_MESSAGES: Record<number, string> = {
  // The only reachable 400s are undecodable sources (`IPX_INVALID_IMAGE`,
  // `IPX_INVALID_SVG`): the modifiers ipx receives are width/quality/format, all
  // already validated by `parseImageRequest()`.
  400: '"url" parameter is valid but upstream is not an image',
  403: '"url" parameter is not allowed',
  404: '"url" parameter is valid but upstream response is invalid',
  // DNS failure, redirect loop, bad redirect
  502: '"url" parameter is valid but upstream response is invalid',
};

function ipxError(status: number): Response {
  return new Response(IPX_ERROR_MESSAGES[status] || "Image optimization failed", { status });
}

/**
 * Parses and validates the Vercel `/_vercel/image` query string.
 *
 * Every rejection is returned as a `Response` so the caller can pass Vercel's own
 * plain-text error messages straight through. `accept` only drives format
 * negotiation when the request carries no `f` param.
 */
function parseImageRequest(
  url: URL,
  accept: string,
  config: VercelImageConfig | undefined,
): ParsedImageRequest | Response {
  const sourceUrl = url.searchParams.get("url");
  if (!sourceUrl) {
    return badRequest('"url" parameter is required');
  }

  const w = url.searchParams.get("w");
  if (!w) {
    return badRequest('"w" parameter is required');
  }
  // Reject trailing garbage ("8abc") and signs/hex that `parseInt` would accept
  if (!/^\d+$/.test(w)) {
    return badRequest('"w" must be a positive integer');
  }
  const width = Number.parseInt(w, 10);
  if (width <= 0) {
    return badRequest('"w" must be a positive integer');
  }
  if (config?.sizes?.length && !config.sizes.includes(width)) {
    return badRequest(`"w" must be one of: ${config.sizes.join(", ")}`);
  }

  // An omitted `q` snaps to the closest configured quality rather than a hard 75
  // that a narrow `qualities` list would then reject on every default request.
  const q = url.searchParams.get("q");
  let quality: number;
  if (q === null) {
    quality = nearestQuality(DEFAULT_QUALITY, config?.qualities);
  } else {
    if (!/^\d+$/.test(q)) {
      return badRequest('"q" must be between 1 and 100');
    }
    quality = Number.parseInt(q, 10);
    if (quality < 1 || quality > 100) {
      return badRequest('"q" must be between 1 and 100');
    }
    if (config?.qualities?.length && !config.qualities.includes(quality)) {
      return badRequest(`"q" must be one of: ${config.qualities.join(", ")}`);
    }
  }

  const allowedFormats = config?.formats?.map(bareFormat);
  const f = url.searchParams.get("f");
  const format = f ? bareFormat(f) : undefined;
  if (format && allowedFormats?.length && !allowedFormats.includes(format)) {
    return badRequest(`"f" must be one of: ${config!.formats!.join(", ")}`);
  }

  // Reject protocol-relative URLs to avoid local/remote ambiguity
  if (sourceUrl.startsWith("//")) {
    return badRequest('"url" parameter is not allowed');
  }

  const isLocal = sourceUrl.startsWith("/");
  const isRemote = isRemoteUrl(sourceUrl);
  if (!isLocal && !isRemote) {
    return badRequest('"url" parameter is not allowed');
  }
  if (isRemote && !validateRemoteUrl(sourceUrl, config)) {
    return badRequest('"url" parameter is not allowed');
  }
  if (isLocal && !validateLocalUrl(sourceUrl, config)) {
    return badRequest('"url" parameter is not allowed');
  }

  // Block SVG unless explicitly allowed
  if (!config?.dangerouslyAllowSVG && isSvgSource(sourceUrl)) {
    return badRequest('"url" parameter is valid but image type is not allowed');
  }

  const modifiers: Record<string, string | number> = { width, quality };

  // Format: explicit param > Accept header negotiation
  const resolvedFormat = format ?? negotiateFormat(accept, allowedFormats);
  if (resolvedFormat) {
    modifiers.format = resolvedFormat;
  }

  return { sourceUrl, modifiers };
}

// --- Unoptimized fallback ---

async function fetchUnoptimized(
  sourceUrl: string,
  getAddress: () => WorkerAddress | undefined,
  config: VercelImageConfig | undefined,
  maxAge: number,
): Promise<Response> {
  let res: Response;
  try {
    if (sourceUrl.startsWith("/")) {
      const address = getAddress();
      if (!address) {
        return new Response("Runner not ready", { status: 503 });
      }
      res = await fetch(resolveWorkerUrl(address, sourceUrl));
    } else {
      res = await fetch(sourceUrl);
    }
  } catch {
    // Connection refused, DNS failure, aborted upstream
    return new Response('"url" parameter is valid but upstream response is invalid', {
      status: 502,
    });
  }

  // A failed upstream is a missing or broken source, not a content-type problem
  if (!res.ok) {
    return new Response('"url" parameter is valid but upstream response is invalid', {
      status: res.status,
    });
  }

  const headers = new Headers(res.headers);
  const contentType = headers.get("content-type") || "";
  if (!/^image\//i.test(contentType)) {
    return new Response('"url" parameter is valid but upstream is not an image', {
      status: 400,
    });
  }
  if (!config?.dangerouslyAllowSVG && /^image\/svg\+xml\b/i.test(contentType)) {
    return new Response('"url" parameter is valid but image type is not allowed', {
      status: 400,
    });
  }
  ensureVaryAccept(headers);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", `public, max-age=${maxAge}, s-maxage=${maxAge}`);
  }
  applySecurityHeaders(headers, sourceUrl, config);

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// --- Handler factory ---

export interface VercelImageHandler {
  handle: (request: Request) => Promise<Response>;
  close: () => void;
}

export function createVercelImageHandler(opts: {
  getAddress: () => WorkerAddress | undefined;
  config?: VercelImageConfig;
}): VercelImageHandler {
  const { getAddress, config } = opts;
  const maxAge = config?.minimumCacheTTL ?? DEFAULT_MAX_AGE;

  type IPXFetchHandler = ReturnType<IPXModule["createIPXFetchHandler"]>;
  type FetchHandlerFactory = (parsed: ParsedImageRequest) => IPXFetchHandler;

  let _factoryPromise: Promise<FetchHandlerFactory | undefined> | undefined;

  // The ipx instance is the expensive half (it memoizes the sharp/svgo imports), so
  // it is built once and reused; the fetch handler around it is built per request.
  function getFetchHandlerFactory(): Promise<FetchHandlerFactory | undefined> {
    _factoryPromise ||= (async () => {
      const ipxModule = await loadIPX();
      if (!ipxModule) return undefined;

      const workerStorage: import("ipx").IPXStorage = {
        name: "vercel:worker",
        async getMeta(id) {
          const address = getAddress();
          if (!address) return undefined;
          try {
            const res = await fetch(resolveWorkerUrl(address, id), { method: "HEAD" });
            // Not every framework answers HEAD; existence is decided by `getData()`
            // so a failed probe only means "no last-modified available".
            if (!res.ok) return { maxAge };
            const lastModified = res.headers.get("last-modified");
            return {
              mtime: lastModified ? new Date(lastModified) : undefined,
              maxAge,
            };
          } catch {
            return { maxAge };
          }
        },
        async getData(id) {
          const address = getAddress();
          if (!address) return undefined;
          try {
            const res = await fetch(resolveWorkerUrl(address, id));
            if (!res.ok) return undefined;
            return await res.arrayBuffer();
          } catch {
            return undefined;
          }
        },
      };

      // The requested remote URL is already validated against domains/remotePatterns
      // before the handler is called, but ipx follows redirects itself and only
      // re-validates the hops when it has an allowlist of its own — so pass the literal
      // hostnames whenever the config has no globs/regexes, and fall back to
      // allowAllDomains otherwise (see `literalHostnames()`).
      const domains = literalHostnames(config);
      const blockPrivateIPs = config?.blockPrivateIPs ?? true;
      const ipx = ipxModule.createIPX({
        storage: workerStorage,
        httpStorage: ipxModule.ipxHttpStorage(
          domains ? { domains, blockPrivateIPs } : { allowAllDomains: true, blockPrivateIPs },
        ),
        maxAge,
      });

      // ipx's own fetch handler owns content-type, ETag/304 revalidation,
      // last-modified and the baseline security headers. `parseURL` only ever sees a
      // URL, which can't carry the Accept-negotiated format, so it closes over the
      // parse `handle()` already did instead of re-deriving it.
      return ({ sourceUrl, modifiers }) =>
        ipxModule.createIPXFetchHandler(ipx, {
          parseURL: () => ({ id: sourceUrl, modifiers }),
        });
    })();
    return _factoryPromise;
  }

  return {
    close() {
      _factoryPromise = undefined;
    },
    async handle(request: Request): Promise<Response> {
      // The endpoint only reads images; anything but GET/HEAD is rejected rather
      // than silently optimizing, matching the deployed endpoint.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }

      const parsed = parseImageRequest(
        new URL(request.url),
        request.headers.get("accept") || "",
        config,
      );
      if (parsed instanceof Response) {
        return parsed;
      }
      const { sourceUrl } = parsed;

      // Only local sources go through the worker; a remote source never touches it.
      if (sourceUrl.startsWith("/")) {
        const socketError = rejectSocketAddress(getAddress());
        if (socketError) {
          return socketError;
        }
      }

      const createFetchHandler = await getFetchHandlerFactory();
      if (!createFetchHandler) {
        return fetchUnoptimized(sourceUrl, getAddress, config, maxAge);
      }

      let res: Response;
      try {
        res = await createFetchHandler(parsed)(request);
      } catch (error: any) {
        // Unexpected: ipx converts its own HTTPErrors into responses. Log the detail,
        // since the body is normalized like every other error.
        console.warn("[env-runner] vercel image optimization failed:", error);
        return ipxError(error.status || error.statusCode || 500);
      }

      // 404 for a missing source, 403 for a forbidden host/IP, 400 for an undecodable
      // one — right statuses, but ipx's JSON body names its own codes and the source path.
      if (!res.ok && res.status !== 304) {
        return ipxError(res.status);
      }

      // Defense in depth: block SVG output even if the URL check was bypassed
      if (
        !config?.dangerouslyAllowSVG &&
        /^image\/svg\+xml\b/i.test(res.headers.get("content-type") || "")
      ) {
        return new Response('"url" parameter is valid but image type is not allowed', {
          status: 400,
        });
      }

      const headers = new Headers(res.headers);
      headers.set("cache-control", `public, max-age=${maxAge}, s-maxage=${maxAge}`);
      ensureVaryAccept(headers);
      applySecurityHeaders(headers, sourceUrl, config);

      if (res.status === 304) {
        return new Response(null, { status: 304, headers });
      }

      // Buffered so `content-length` is always set (ipx has the whole image in
      // memory anyway, there is no streaming to preserve).
      const body = new Uint8Array(await res.arrayBuffer());
      headers.set("content-length", String(body.byteLength));
      return new Response(body, { status: res.status, headers });
    },
  };
}
