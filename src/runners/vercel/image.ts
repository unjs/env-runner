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
}

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

function resolveWorkerUrl(address: WorkerAddress, path: string): string {
  if ("socketPath" in address && address.socketPath) {
    throw new Error(
      "Vercel image handler requires a TCP worker address (host/port); unix sockets are not supported.",
    );
  }
  const host = address.host || "127.0.0.1";
  return `http://${host}:${address.port}${path}`;
}

// --- URL validation ---

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

// Build Output API uses PCRE regex (^...$), Next.js config uses globs (**, *)
function matchPattern(pattern: string, value: string): boolean {
  if (pattern.startsWith("^") && pattern.endsWith("$")) {
    return new RegExp(pattern).test(value);
  }
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
  return new RegExp(re + "$").test(value);
}

function matchRemotePattern(pattern: VercelRemotePattern, url: URL): boolean {
  if (pattern.protocol && url.protocol !== pattern.protocol + ":") return false;
  if (!matchPattern(pattern.hostname, url.hostname)) return false;
  if (pattern.port !== undefined && url.port !== pattern.port) return false;
  if (pattern.pathname && !matchPattern(pattern.pathname, url.pathname)) return false;
  if (pattern.search !== undefined && url.search !== pattern.search) return false;
  return true;
}

function validateRemoteUrl(sourceUrl: string, config?: VercelImageConfig): boolean {
  if (!config?.domains?.length && !config?.remotePatterns?.length) {
    return true;
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

function applySecurityHeaders(
  headers: Headers | Record<string, string>,
  sourceUrl: string,
  config?: VercelImageConfig,
): void {
  const set = (key: string, value: string) => {
    if (headers instanceof Headers) headers.set(key, value);
    else headers[key] = value;
  };
  if (config?.contentSecurityPolicy) {
    set("content-security-policy", config.contentSecurityPolicy);
  } else if (config?.dangerouslyAllowSVG) {
    // Match Next.js default CSP when SVGs are allowed
    set("content-security-policy", "script-src 'none'; frame-src 'none'; sandbox;");
  }
  if (config?.contentDispositionType) {
    const filename = sourceUrl.split("/").pop()?.split("?")[0] || "image";
    set("content-disposition", `${config.contentDispositionType}; filename="${filename}"`);
  }
}

// --- Unoptimized fallback ---

async function fetchUnoptimized(
  sourceUrl: string,
  getAddress: () => WorkerAddress | undefined,
  config?: VercelImageConfig,
  cacheTTL?: number,
): Promise<Response> {
  let res: Response;
  if (sourceUrl.startsWith("/")) {
    const address = getAddress();
    if (!address) {
      return new Response("Runner not ready", { status: 503 });
    }
    res = await fetch(resolveWorkerUrl(address, sourceUrl));
  } else {
    res = await fetch(sourceUrl);
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
  const existingVary = headers.get("vary");
  if (!existingVary) {
    headers.set("vary", "Accept");
  } else if (!/(^|,\s*)Accept(\s*,|\s*$)/i.test(existingVary)) {
    headers.set("vary", `${existingVary}, Accept`);
  }
  if (!headers.has("cache-control")) {
    const ttl = cacheTTL ?? config?.minimumCacheTTL ?? 60;
    headers.set("cache-control", `public, max-age=${ttl}, s-maxage=${ttl}`);
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

  let _ipx: ReturnType<IPXModule["createIPX"]> | undefined;
  let _ipxPromise: Promise<ReturnType<IPXModule["createIPX"]> | undefined> | undefined;

  async function getIPX() {
    if (_ipx) return _ipx;
    if (_ipxPromise) return _ipxPromise;
    _ipxPromise = (async () => {
      const ipxModule = await loadIPX();
      if (!ipxModule) return undefined;

      const workerStorage: import("ipx").IPXStorage = {
        name: "vercel:worker",
        async getMeta(id) {
          const address = getAddress();
          if (!address) return undefined;
          try {
            const res = await fetch(resolveWorkerUrl(address, id), { method: "HEAD" });
            if (!res.ok) return undefined;
            const lastModified = res.headers.get("last-modified");
            return {
              mtime: lastModified ? new Date(lastModified) : undefined,
              maxAge: config?.minimumCacheTTL ?? 60,
            };
          } catch {
            return undefined;
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

      // Remote URL validation is handled before calling ipx(), so
      // allow all domains here and let our validation layer handle restrictions
      _ipx = ipxModule.createIPX({
        storage: workerStorage,
        httpStorage: ipxModule.ipxHttpStorage({ allowAllDomains: true }),
        maxAge: config?.minimumCacheTTL ?? 60,
      });

      return _ipx;
    })();
    return _ipxPromise;
  }

  return {
    close() {
      _ipx = undefined;
      _ipxPromise = undefined;
    },
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);

      const sourceUrl = url.searchParams.get("url");
      const w = url.searchParams.get("w");
      const q = url.searchParams.get("q") || "75";
      const f = url.searchParams.get("f");
      const fit = url.searchParams.get("fit");
      const h = url.searchParams.get("h");
      const blur = url.searchParams.get("blur");

      if (!sourceUrl) {
        return new Response('"url" parameter is required', { status: 400 });
      }
      if (!w) {
        return new Response('"w" parameter is required', { status: 400 });
      }

      const width = Number.parseInt(w);
      if (Number.isNaN(width) || width <= 0) {
        return new Response('"w" must be a positive integer', { status: 400 });
      }

      const quality = Number.parseInt(q);
      if (Number.isNaN(quality) || quality < 1 || quality > 100) {
        return new Response('"q" must be between 1 and 100', { status: 400 });
      }

      if (config?.sizes?.length && !config.sizes.includes(width)) {
        return new Response(`"w" must be one of: ${config.sizes.join(", ")}`, { status: 400 });
      }

      if (config?.qualities?.length && !config.qualities.includes(quality)) {
        return new Response(`"q" must be one of: ${config.qualities.join(", ")}`, { status: 400 });
      }

      if (f && config?.formats?.length && !config.formats.includes(f)) {
        return new Response(`"f" must be one of: ${config.formats.join(", ")}`, { status: 400 });
      }

      // Reject protocol-relative URLs to avoid local/remote ambiguity
      if (sourceUrl.startsWith("//")) {
        return new Response('"url" parameter is not allowed', { status: 400 });
      }

      // Validate source URL against allowlists
      const isLocal = sourceUrl.startsWith("/");
      const isRemote = isRemoteUrl(sourceUrl);
      if (!isLocal && !isRemote) {
        return new Response('"url" parameter is not allowed', { status: 400 });
      }
      if (isRemote && !validateRemoteUrl(sourceUrl, config)) {
        return new Response('"url" parameter is not allowed', { status: 400 });
      }
      if (isLocal && !validateLocalUrl(sourceUrl, config)) {
        return new Response('"url" parameter is not allowed', { status: 400 });
      }

      // Block SVG unless explicitly allowed
      if (!config?.dangerouslyAllowSVG && isSvgSource(sourceUrl)) {
        return new Response('"url" parameter is valid but image type is not allowed', {
          status: 400,
        });
      }

      const cacheOverride = Number.parseInt(url.searchParams.get("cache") || "");
      const cacheTTL =
        Number.isFinite(cacheOverride) && cacheOverride > 0
          ? cacheOverride
          : (config?.minimumCacheTTL ?? 60);

      const ipx = await getIPX();
      if (!ipx) {
        return fetchUnoptimized(sourceUrl, getAddress, config, cacheTTL);
      }

      // Build IPX modifiers
      const modifiers: Record<string, string | number> = { width, quality };
      if (h) {
        const height = Number.parseInt(h);
        if (!Number.isNaN(height) && height > 0) {
          modifiers.height = height;
        }
      }
      if (fit) {
        modifiers.fit = fit;
      }
      if (blur) {
        const blurValue = Number.parseInt(blur);
        if (!Number.isNaN(blurValue) && blurValue > 0) {
          modifiers.blur = blurValue;
        }
      }

      // Format: explicit param > Accept header negotiation
      if (f) {
        modifiers.format = f.replace("image/", "");
      } else {
        const accept = request.headers.get("accept") || "";
        const allowed = config?.formats?.map((fmt) => fmt.replace(/^image\//, ""));
        const isAllowed = (fmt: string) => !allowed || allowed.includes(fmt);
        if (accept.includes("image/avif") && isAllowed("avif")) {
          modifiers.format = "avif";
        } else if (accept.includes("image/webp") && isAllowed("webp")) {
          modifiers.format = "webp";
        }
      }

      try {
        const img = ipx(sourceUrl, modifiers);
        const { data, format } = await img.process();

        // Defense in depth: block SVG output even if the URL check was bypassed
        if (!config?.dangerouslyAllowSVG && format === "svg+xml") {
          return new Response('"url" parameter is valid but image type is not allowed', {
            status: 400,
          });
        }

        const contentType = format ? `image/${format}` : "application/octet-stream";
        const body =
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

        const headers: Record<string, string> = {
          "content-type": contentType,
          "content-length": String(body.byteLength),
          "cache-control": `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
          vary: "Accept",
        };
        applySecurityHeaders(headers, sourceUrl, config);

        return new Response(body, { headers });
      } catch (error: any) {
        const status = error.statusCode || 500;
        return new Response(error.message || "Image optimization failed", { status });
      }
    },
  };
}
