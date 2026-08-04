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

// Shared by request validation, the ipx path, the unoptimized fallback and the ipx
// error mapping, so all four answer a given failure with the same body. These are
// the messages Next.js' image optimizer uses; Vercel's own `/_vercel/image`
// answers every rejection with a generic `INVALID_IMAGE_OPTIMIZE_REQUEST` page,
// which says nothing useful in dev.
const MESSAGES = {
  notAllowed: '"url" parameter is not allowed',
  notAnImage: '"url" parameter is valid but upstream is not an image',
  typeNotAllowed: '"url" parameter is valid but image type is not allowed',
  upstreamInvalid: '"url" parameter is valid but upstream response is invalid',
} as const;

type IPXModule = typeof import("ipx");

let _ipxPromise: Promise<IPXModule | undefined> | undefined;

function loadIPX(): Promise<IPXModule | undefined> {
  return (_ipxPromise ||= import("ipx").catch(() => {
    console.warn(
      "ipx is not installed. Install it for Vercel image optimization: npx nypm i -D ipx",
    );
    return undefined;
  }));
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

// Denies the rule it came from instead of matching everything. Safe to share:
// without a `g`/`y` flag, `.test()` keeps no per-regex state.
const NEVER_MATCH = /(?!)/;

function patternToRegExp(pattern: string): RegExp {
  let compiled = _patternCache.get(pattern);
  if (compiled) return compiled;
  if (pattern.startsWith("^") && pattern.endsWith("$")) {
    // Build Output API patterns are raw user-authored regex, so a typo is a
    // `SyntaxError` — which threw straight out of `handle()` via
    // `validateLocalUrl()`, and was silently swallowed as a blanket deny by
    // `validateRemoteUrl()`'s `catch`. Warn once (the cache below makes it once
    // per pattern) and fail closed, so one bad rule can't take down the endpoint.
    try {
      compiled = new RegExp(pattern);
    } catch {
      console.warn(`[env-runner] ignoring invalid Vercel image pattern: ${pattern}`);
      compiled = NEVER_MATCH;
    }
  } else {
    // The glob branch can't throw: `[` and `]` are escaped below, so no
    // character class — the one unterminated construct a glob could produce — forms.
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

// Takes the parsed (and therefore normalized) local URL rather than the raw string:
// see `parseImageRequest()` for why the two must not diverge.
function validateLocalUrl(sourceUrl: URL, config?: VercelImageConfig): boolean {
  if (!config?.localPatterns?.length) return true;
  const search = sourceUrl.search.replace(/^\?/, "");
  return config.localPatterns.some((p) => {
    if (p.pathname && !matchPattern(p.pathname, sourceUrl.pathname)) return false;
    if (p.search !== undefined && search !== p.search.replace(/^\?/, "")) return false;
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
  let path = url;
  if (!url.startsWith("/")) {
    try {
      path = new URL(url).pathname;
    } catch {
      // Not a valid absolute URL either; fall back to matching the raw string.
    }
  }
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
    headers.set(
      "content-disposition",
      contentDisposition(config.contentDispositionType, sourceUrl),
    );
  }
}

// A quoted `filename` can carry neither quotes/backslashes (they terminate or
// escape the value) nor anything above U+00FF: `Headers.set()` throws on a
// non-ByteString value, and that `TypeError` escaped `handle()` as an unhandled
// rejection for any source with a non-Latin1 name (`/日本.png`). So quotes are
// stripped, everything outside printable ASCII is replaced, and the real name is
// carried by RFC 5987 `filename*` — appended only when it differs, so the common
// case stays byte-identical to what Vercel sends.
function contentDisposition(type: string, sourceUrl: string): string {
  const segment = sourceUrl.split("?")[0]!.split("/").pop() || "";
  let name = segment;
  try {
    // A local source is normalized (and therefore percent-encoded) by the time it
    // gets here, so decode it back into the name the user recognizes.
    name = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding; keep the raw segment.
  }
  name = name.replaceAll(/["\\]/g, "") || "image";
  const ascii = name.replaceAll(/[^\u0020-\u007E]/g, "_");
  const value = `${type}; filename="${ascii}"`;
  return ascii === name ? value : `${value}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Content-type is the source of truth for the SVG block, not the URL: a source
// whose URL doesn't look like SVG can still resolve to `image/svg+xml`, so both
// the ipx path and the unoptimized fallback re-check it on the response.
function blockSvgOutput(contentType: string, config?: VercelImageConfig): Response | undefined {
  // `image/svg` (without the `+xml`) as well: browsers do not render it, but there
  // is no reason for the check to be narrower than the media types it is guarding.
  if (!config?.dangerouslyAllowSVG && /^image\/svg\b/i.test(contentType)) {
    return new Response(MESSAGES.typeNotAllowed, { status: 400 });
  }
  return undefined;
}

// Shared by the ipx path and the unoptimized fallback. `overwriteCacheControl`
// captures their one real difference: ipx's `cache-control` reflects Vercel's own
// `minimumCacheTTL` semantics and always wins, while the fallback only fills it in
// when the upstream didn't already set one.
function finalizeImageHeaders(
  headers: Headers,
  sourceUrl: string,
  config: VercelImageConfig | undefined,
  maxAge: number,
  overwriteCacheControl: boolean,
): void {
  if (overwriteCacheControl || !headers.has("cache-control")) {
    headers.set("cache-control", `public, max-age=${maxAge}, s-maxage=${maxAge}`);
  }
  ensureVaryAccept(headers);
  applySecurityHeaders(headers, sourceUrl, config);
}

// --- Request parsing ---

interface ParsedImageRequest {
  sourceUrl: string;
  isLocal: boolean;
  modifiers: Record<string, string | number>;
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

/**
 * Strips the `image/` prefix so a configured `formats` entry (`image/webp`, as the
 * Build Output API writes it) compares equal to a negotiation candidate (`webp`).
 */
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
  400: MESSAGES.notAnImage,
  403: MESSAGES.notAllowed,
  404: MESSAGES.upstreamInvalid,
  // DNS failure, redirect loop, bad redirect
  502: MESSAGES.upstreamInvalid,
};

// `new Response(body, { status })` throws for a null-body status (204/304) and a
// `RangeError` for anything outside 200-599, either of which would escape
// `handle()`. Statuses that reach here come from an upstream response or from a
// thrown error's `status`/`statusCode`, so neither is trustworthy on its own.
function errorStatus(status: unknown, fallback: number): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

function ipxError(status: unknown): Response {
  const resolved = errorStatus(status, 500);
  return new Response(IPX_ERROR_MESSAGES[resolved] || "Image optimization failed", {
    status: resolved,
  });
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
  let sourceUrl = url.searchParams.get("url");
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

  // Reject protocol-relative URLs to avoid local/remote ambiguity
  if (sourceUrl.startsWith("//")) {
    return badRequest(MESSAGES.notAllowed);
  }

  const isLocal = sourceUrl.startsWith("/");
  if (isLocal) {
    // A local source is normalized before it is validated *and* before it becomes
    // the fetch id, so the allowlist sees exactly the path the worker will be asked
    // for. Matching the raw string instead let `/assets/../secret.png` satisfy a
    // `/assets/**` rule and then resolve to `/secret.png` once fetched, and the
    // hand-rolled `split("?")` hid everything after a second `?` from a `search`
    // rule (`/a.png?v=1?evil=2` passed `search: "?v=1"`).
    const localUrl = new URL(sourceUrl, "http://localhost");
    sourceUrl = localUrl.pathname + localUrl.search;
    if (!validateLocalUrl(localUrl, config)) {
      return badRequest(MESSAGES.notAllowed);
    }
  } else if (isRemoteUrl(sourceUrl)) {
    if (!validateRemoteUrl(sourceUrl, config)) {
      return badRequest(MESSAGES.notAllowed);
    }
  } else {
    return badRequest(MESSAGES.notAllowed);
  }

  // Block SVG unless explicitly allowed
  if (!config?.dangerouslyAllowSVG && isSvgSource(sourceUrl)) {
    return badRequest(MESSAGES.typeNotAllowed);
  }

  const modifiers: Record<string, string | number> = { width, quality };

  // The output format is negotiated from `Accept` and nothing else, matching the
  // deployed endpoint: it honors `url`, `w` and `q`, and ignores every other query
  // param. A param that pinned the format here would be a transform that works in
  // dev and silently disappears in production — the same reason `h`/`fit`/`blur`
  // are not supported.
  const resolvedFormat = negotiateFormat(accept, config?.formats?.map(bareFormat));
  if (resolvedFormat) {
    modifiers.format = resolvedFormat;
  }

  return { sourceUrl, isLocal, modifiers };
}

// --- Unoptimized fallback ---

// Everything else the upstream sent is dropped. `fetch` has already decoded the
// body, so forwarding `content-encoding` (and the compressed `content-length`
// beside it) left the client unable to decode what it received — and a `set-cookie`
// from a remote image origin has no business being served under the app's own.
const PASSTHROUGH_HEADERS = ["content-type", "etag", "last-modified", "cache-control"];

function imageHeadersFrom(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  // Only describes the body about to be served when nothing was encoded on the wire.
  if (!upstream.has("content-encoding")) {
    const length = upstream.get("content-length");
    if (length) headers.set("content-length", length);
  }
  return headers;
}

// An upstream body that is never read keeps its socket checked out of undici's pool
// until the response is garbage collected.
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

async function fetchUnoptimized(
  sourceUrl: string,
  isLocal: boolean,
  getAddress: () => WorkerAddress | undefined,
  config: VercelImageConfig | undefined,
  maxAge: number,
): Promise<Response> {
  let res: Response;
  try {
    if (isLocal) {
      const address = getAddress();
      if (!address) {
        return new Response("Runner not ready", { status: 503 });
      }
      // Redirects are followed here, matching `workerStorage.getData()` on the ipx
      // path: a framework may legitimately redirect its own asset paths.
      res = await fetch(resolveWorkerUrl(address, sourceUrl));
    } else {
      // `validateRemoteUrl()` only gated this URL, and a redirect leaves it — an
      // allowlisted host could bounce the fetch to an internal address. The ipx path
      // re-validates every hop via `ipxHttpStorage({ domains })`, so refuse them
      // here rather than let the fallback be the weaker path (`blockPrivateIPs`
      // is an ipx-only knob and does not apply to this `fetch`).
      res = await fetch(sourceUrl, { redirect: "error" });
    }
  } catch {
    // Connection refused, DNS failure, aborted upstream, refused redirect
    return new Response(MESSAGES.upstreamInvalid, { status: 502 });
  }

  // A failed upstream is a missing or broken source, not a content-type problem.
  // Its status is reused only when it is one a `Response` can carry (a `304` from a
  // worker answering an unconditional request would otherwise throw).
  if (!res.ok) {
    discardBody(res);
    return new Response(MESSAGES.upstreamInvalid, { status: errorStatus(res.status, 502) });
  }

  const contentType = res.headers.get("content-type") || "";
  if (!/^image\//i.test(contentType)) {
    discardBody(res);
    return new Response(MESSAGES.notAnImage, { status: 400 });
  }
  const svgBlock = blockSvgOutput(contentType, config);
  if (svgBlock) {
    discardBody(res);
    return svgBlock;
  }

  const headers = imageHeadersFrom(res.headers);
  finalizeImageHeaders(headers, sourceUrl, config, maxAge, false);

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
      const { sourceUrl, isLocal } = parsed;

      // Only local sources go through the worker; a remote source never touches it.
      if (isLocal) {
        const socketError = rejectSocketAddress(getAddress());
        if (socketError) {
          return socketError;
        }
      }

      const createFetchHandler = await getFetchHandlerFactory();
      if (!createFetchHandler) {
        return fetchUnoptimized(sourceUrl, isLocal, getAddress, config, maxAge);
      }

      let res: Response;
      try {
        res = await createFetchHandler(parsed)(request);
      } catch (error: any) {
        // Unexpected: ipx converts its own HTTPErrors into responses. Log the detail,
        // since the body is normalized like every other error.
        console.warn("[env-runner] vercel image optimization failed:", error);
        return ipxError(error.status ?? error.statusCode);
      }

      // 404 for a missing source, 403 for a forbidden host/IP, 400 for an undecodable
      // one — right statuses, but ipx's JSON body names its own codes and the source path.
      if (!res.ok && res.status !== 304) {
        return ipxError(res.status);
      }

      // Defense in depth: block SVG output even if the URL check was bypassed
      const svgBlock = blockSvgOutput(res.headers.get("content-type") || "", config);
      if (svgBlock) return svgBlock;

      const headers = new Headers(res.headers);
      finalizeImageHeaders(headers, sourceUrl, config, maxAge, true);

      // ipx (via h3) already nulls the body for 304s and for HEAD requests, in
      // both cases keeping the `content-length` it computed from the full image.
      // Buffering `res.arrayBuffer()` below would read that as empty and clobber
      // a correct header with `0`, so a null body always short-circuits first.
      if (res.body === null) {
        return new Response(null, { status: res.status, headers });
      }

      // Buffered so `content-length` is always set (ipx has the whole image in
      // memory anyway, there is no streaming to preserve).
      const body = new Uint8Array(await res.arrayBuffer());
      headers.set("content-length", String(body.byteLength));
      return new Response(body, { status: res.status, headers });
    },
  };
}
