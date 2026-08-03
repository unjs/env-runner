# VercelEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Vercel deployment environment.

## Source files

- **`src/runners/vercel/runner.ts`** — `VercelEnvRunner` extends `NodeWorkerEnvRunner`: simulates Vercel deployment environment with header injection
- **`src/runners/vercel/worker.ts`** — Sets Vercel env vars and `Symbol.for("@vercel/request-context")` on globalThis, delegates to node-worker worker
- **`src/runners/vercel/oidc.ts`** — `_checkVercelOidcToken()` decodes `VERCEL_OIDC_TOKEN` (JWT `exp` claim, no signature check) and returns `{ status: "missing" | "valid" | "expired" | "invalid", expiresAt? }`. `warnIfVercelOidcTokenInvalid()` logs a one-time dev warning hinting the user to run `vercel env pull`. Called from the `VercelEnvRunner` constructor
- **`src/runners/vercel/queue-dev.ts`** — Bridge for local Vercel Queues delivery. `await registerVercelQueueConsumer({ topic, handler, consumerGroup?, visibilityTimeoutSeconds?, retry?, retryAfterSeconds? })` lets framework plugins bind a topic to a dispatcher; the first call lazy-loads `@vercel/queue` and constructs a shared `QueueClient`. Resolves to an unregister function. Re-registering the same `consumerGroup` on a topic replaces the handler via the SDK's own `consumerGroup` keying (HMR-safe; the unregister for a replaced registration becomes a no-op). `retryAfterSeconds` is a shorthand for `retry: () => ({ afterSeconds })`; pass `retry` for richer directives like `{ acknowledge: true }`
- **`src/runners/vercel/image.ts`** — `createVercelImageHandler()`: handles `/_vercel/image` requests using IPX for image optimization. Serves `GET`/`HEAD` only (405 otherwise) and supports the `url`, `w`, `q`, `f` query params. `parseImageRequest()` parses and validates in one place (returning a `Response` for every rejection so Vercel's plain-text messages pass straight through): remote URLs are default-deny unless matched by `domains`/`remotePatterns`, local URLs are narrowed by `localPatterns`, SVG is blocked by default. It then delegates to ipx v4's `createIPXFetchHandler()` (ETag/304, content-type, security headers), whose `parseURL` closes over that single parse. Falls back to unoptimized proxy when `ipx` is not installed

## How it works

Extends `NodeWorkerEnvRunner` to simulate a Vercel deployment environment. The worker sets `Symbol.for("@vercel/request-context")` on `globalThis` (with `waitUntil`, `cache`, `purge`, `addCacheTag`) for `@vercel/functions` compatibility, sets Vercel environment variables, then delegates to the node-worker worker.

**Environment variables** (set in worker thread, won't override if already set):

- `VERCEL` — `"1"`
- `VERCEL_ENV` — `"development"`
- `NODE_ENV` — `"development"` (gates `@vercel/queue`'s dev mode and other framework dev paths)

`VERCEL_REGION` and `NOW_REGION` are intentionally not defaulted — Vercel SDKs rely on them being valid region identifiers when set, so they must be explicitly provided if required.

**Request header injection:** Overrides `fetch()` to inject Vercel-specific headers before delegating to the parent. `fetch()` awaits readiness up front (`waitForReady()`, which rejects immediately once the runner is closed) because both dispatch paths need the worker address and `x-vercel-deployment-url` is derived from it — without the wait, the first request to a cold runner would silently omit that header. A runner that never reports an address yields a single `503 "vercel env runner is unavailable"` that still carries the Vercel response headers.

A `Request` input is forwarded to `super.fetch()` **as-is**, never re-wrapped in `new Request(input, …)`: `cli.ts` hands the front server's own request object straight through, and srvx's request class passes `instanceof Request` while the undici `Request` constructor refuses to clone it (`Cannot read private member #state …`). Header injection still wins because httpxy's `proxyFetch()` merges `init` over a `Request`'s own fields. The `/_vercel/image` branch builds its request from the parsed `URL` instead, for the same reason. `test/vercel.test.ts` covers this through a real srvx server.

Injected headers:

- `x-vercel-deployment-url` — constructed from the worker's address (`http://<host>:<port>`)
- `x-vercel-id` — unique request ID in format `dev1::<podId>-<timestamp>-<hex>` (stable podId per process, matches vercel dev behavior)
- `x-vercel-forwarded-for` — derived from `x-forwarded-for` (first IP) or `x-real-ip`, defaults to `127.0.0.1`
- `x-forwarded-for`, `x-real-ip` — set to client IP if not already present
- `x-forwarded-proto` — protocol from request URL
- `x-forwarded-host` — from `host` header or request URL

**Response header injection:** After proxying, injects response headers:

- `server` — `"Vercel"`
- `x-vercel-id` — same request ID as the request header
- `x-vercel-cache` — `"MISS"`

All headers are only injected when not already present in the request/response.

**Local Vercel Queues delivery:** Frameworks running inside the worker `await registerVercelQueueConsumer({ topic, handler, consumerGroup?, visibilityTimeoutSeconds?, retry?, retryAfterSeconds? })` from `env-runner/runners/vercel/queue-dev` (e.g. Nitro forwards delivered messages to its `vercel:queue` runtime hook). The first call lazy-imports `@vercel/queue`, constructs a shared `QueueClient`, and registers a dev consumer via `registerDevConsumer`. Subsequent calls reuse the client; re-registering the same `consumerGroup` on a topic replaces the handler in place (HMR-safe). `retryAfterSeconds` is shorthand for a constant-delay retry; pass `retry: (error, metadata) => RetryDirective` for richer directives (`{ afterSeconds }`, `{ acknowledge: true }`, or `undefined` to propagate). If `@vercel/queue` is not installed or is too old to expose `registerDevConsumer`, a one-time warning is logged and registrations resolve to a no-op unregister — dev startup is never blocked.

**Image optimization (`/_vercel/image`):** Intercepts requests to `/_vercel/image` and processes images using IPX (optional `ipx` peer dependency). Supports Vercel's image optimization query parameters:

- `url` (required) — source image URL (local path or absolute URL)
- `w` (required) — output width in pixels. Must be a bare non-negative integer (`^\d+$`); `parseInt`-style inputs like `8abc`, `0x10`, `1e3` are rejected
- `q` (optional, default 75) — quality 1–100, same strict-integer rule as `w`. When `qualities` is configured, an omitted `q` snaps to the configured value closest to 75 instead of being rejected
- `f` (optional) — output format, as a MIME type (`image/webp`) or a bare name (`webp`); both forms are compared against `formats` with the `image/` prefix stripped

These are exactly the params the real `/_vercel/image` endpoint honors (`url`, `w`, `q` — `f` is our internal format-pinning param, see below). Vercel ignores any other query param, so we deliberately do **not** support `h`/`fit`/`blur`/`cache`: honoring them in dev would produce transforms that silently vanish in production. `f` aside, unknown params are ignored, matching Vercel.

Only `GET` and `HEAD` are served; any other method gets `405` with `Allow: GET, HEAD` before the query is even parsed, so a stray `POST` can't silently return an optimized image.

Format auto-detection from `Accept` header when `f` is not provided (prefers avif > webp). ipx's own `f=auto` is deliberately **not** used: its `autoDetectFormat()` falls back to `jpeg` when the `Accept` header offers nothing better, which would flatten PNG transparency, whereas Vercel keeps the source format. Response includes `Vary: Accept` for proper cache keying. Local images are fetched from the worker; remote images are fetched directly.

**Unoptimized fallback:** when `ipx` is not installed, the handler warns once and proxies the source image. This path is kept at parity with the ipx path rather than being the weaker one: a non-ok upstream forwards its own status with `"url" parameter is valid but upstream response is invalid` (a missing local source is a 404, not a 400 "not an image"), an unreachable upstream is a `502` instead of an escaping fetch rejection, and `content-security-policy: default-src 'none'` is applied to match what ipx sets on its own responses.

**Worker address:** local sources are fetched over TCP from `getAddress()`. `VercelEnvRunner` always listens on TCP, but `createVercelImageHandler()` is public API taking an arbitrary `getAddress`, so a `socketPath` address is rejected up front with a `500` naming the limitation — otherwise it would build `http://undefined:undefined/…` and the failed fetch would surface as a misleading 404 "resource not found". The check is scoped to local sources; a remote source never touches the worker.

**ipx wiring (v4):** the ipx **instance** is built once, lazily, and memoized for the lifetime of the runner (`close()` drops it) — it is the expensive half, since it memoizes the `sharp` and `svgo` dynamic imports. The **fetch handler** around it is built per request, because `createIPXFetchHandler(ipx, { parseURL })` is only a closure allocation plus an `Object.assign` (~15µs measured, against ~490ms for one sharp encode).

That split is what keeps format negotiation in one place. `parseURL` is ipx v4's supported hook for a non-default URL style, but its signature is `(url: string) => IPXParsedURL` — it never sees the request, so it cannot read the `Accept` header. With a memoized handler, `parseURL` would be a long-lived closure that has to re-derive the modifiers from the URL alone; the negotiated format would then have to be smuggled back into the URL as an explicit `f=<resolved>` so the second parse agreed with the first. Building the handler per request instead lets `parseURL` close over the parse `handle()` already did (`() => ({ id: sourceUrl, modifiers })`), so the query is parsed once, `Accept` is read once, and the request is handed to ipx unmodified. Because nothing re-wraps it, a framework mounting the handler on its own server can pass that server's request class straight through.

ipx owns `content-type`, `etag` (weak, from the source `mtime` + modifiers when available, content-hashed otherwise), `if-none-match`/`if-modified-since` → `304`, `last-modified`, `content-security-policy: default-src 'none'` and `x-content-type-options: nosniff`. The handler then overrides `cache-control` (Vercel semantics, `minimumCacheTTL`), ensures `Vary: Accept`, applies the configured CSP/`content-disposition` (quotes and backslashes are stripped from the filename, which would otherwise terminate the quoted value), and buffers the body to set `content-length` (undici does not derive it from a `Uint8Array` body). **ipx error bodies are re-stated, statuses are kept.** ipx answers failures with an `HTTPError` JSON body naming its own `IPX_*` code and the resolved source path (`{"status":404,"statusText":"IPX_RESOURCE_NOT_FOUND","message":"Resource not found: /sample.jpg"}`). The statuses are already right — better than a blanket 500 — so `IPX_ERROR_MESSAGES` maps each one onto the plain-text message the rest of the endpoint uses, keeping the status: `404`/`502` → `"url" parameter is valid but upstream response is invalid`, `403` (forbidden host/IP) → `"url" parameter is not allowed`, `400` → `"url" parameter is valid but upstream is not an image`, anything else → `Image optimization failed`. That keeps the ipx and unoptimized-fallback paths answering alike and stops ipx internals reaching the client. The only reachable `400`s are undecodable sources (`IPX_INVALID_IMAGE`, `IPX_INVALID_SVG`) — the modifiers ipx receives are just width/quality/format, all validated by `parseImageRequest()` first. A throw escaping ipx's own error handling is not expected, so it is logged once via `console.warn` before the body is normalized the same way.

Two ipx v4 defaults are relied on rather: `maxOutputDimension` (8192) clamps `w`/`h` so a request cannot make sharp allocate a huge buffer, and SVG output is always sanitized (scripts, `on*` handlers, `javascript:` URIs) plus optimized with svgo.

**URL validation:** Remote sources are **default-deny**, matching Vercel — with neither `domains` nor `remotePatterns` configured, every remote `url` is rejected with 400 `"url" parameter is not allowed`. Allowing them by default would both diverge from production and turn the dev server into an open image proxy. Configured remotes are matched against `domains` (exact hostname) and `remotePatterns` (protocol, hostname glob/regex, port, pathname glob/regex). Local paths are allowed unless narrowed by `localPatterns`. Compiled patterns are cached in a module-level `Map` since they are re-tested on every request. SVG sources are blocked by default (400) unless `dangerouslyAllowSVG` is true.

Because ipx follows redirects itself, the allowlist is also handed to `ipxHttpStorage({ domains })` whenever every configured hostname is a literal (`literalHostnames()`), so each redirect hop is re-validated and an allowlisted host cannot bounce the fetch to an internal address. Configs using globs or Build Output API regexes fall back to `allowAllDomains: true` (only the initial URL is gated, by our own matcher).

Constructor accepts optional `images` config (`VercelImageConfig`) matching the Vercel Build Output API `images` property: `sizes`, `domains`, `remotePatterns`, `localPatterns`, `qualities`, `formats`, `minimumCacheTTL`, `dangerouslyAllowSVG`, `contentSecurityPolicy`, `contentDispositionType`. Plus one env-runner extension: `blockPrivateIPs` (**default `true`**) forwards to `ipxHttpStorage` to reject remote sources that are, or resolve to, a non-public IP. It only affects remote sources — local paths always go through the worker storage, never `ipxHttpStorage`. Set it to `false` to optimize from a `localhost`/in-cluster origin.

`createVercelImageHandler()`, `VercelImageConfig` and friends are exported from both `env-runner` and `env-runner/runners/vercel/image`, so a framework can mount the same handler without constructing a `VercelEnvRunner`. It takes `{ getAddress, config }` — `getAddress` is polled per request so it survives hot-reloads, and returns 503 (unoptimized fallback) or 404 (ipx path) while the worker has no address yet. Mounted under `VercelEnvRunner` that window doesn't arise, since `fetch()` awaits readiness before dispatching.

**Known gaps** (not implemented, and worth knowing before treating this as production-shaped): there is no result cache, so an identical request re-runs sharp every time (~490ms measured for a 2.7 MB JPEG → `w=1080` AVIF), and revalidation is only cheap when the worker sends `last-modified` — that lets ipx build a weak ETag from `mtime` and answer 304 in ~1ms, whereas without it ipx must fully re-encode just to compute a content ETag (~484ms, plus a second worker fetch). There is also no cap on concurrent sharp encodes.

## Testing

- Vercel suites (`test/vercel.test.ts` and the Vercel entry in `test/runners.test.ts`) stub a fake far-future `VERCEL_OIDC_TOKEN` via `vi.stubEnv` so the OIDC check doesn't log warnings (real env token takes precedence)
- **`test/vercel.test.ts`** — Tests for `VercelEnvRunner`: request header injection (`x-vercel-deployment-url`, `x-vercel-id`, `x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-proto`, `x-forwarded-host`), response header injection (`server`, `x-vercel-id`, `x-vercel-cache`), environment variables (`VERCEL`, `VERCEL_ENV`, `VERCEL_REGION`, `NOW_REGION`), header preservation, pre-existing header respect. Its `image optimization` block covers **wiring only** — that `/_vercel/image` reaches the handler, that request headers and the request method survive the hop, that the `images` config is threaded through, and that the Vercel response headers are injected on both success and 400 responses. Its `host-runtime request objects` block starts a real srvx server and passes srvx's own request through `fetch()` (both the normal and the image path) — this is the only coverage for the no-re-wrap rule above, since every other test calls `fetch()` with a URL string or an undici `Request`
- **`test/vercel-image.test.ts`** — Unit tests for `createVercelImageHandler()` with a stub `getAddress`, so the whole matrix runs without spawning a worker (~300ms). A single `node:http` server doubles as the worker and as the "remote" origin for the `domains`/`remotePatterns`/`blockPrivateIPs` cases; it decodes the request path so the percent-encoded `/od"d.png` route can exercise `content-disposition` filename escaping. Covers request-method gating (GET/HEAD vs 405), `socketPath` rejection for local sources (and non-rejection for remote ones), parameter validation, remote default-deny, `localPatterns`, SVG, cache-control/`cache`/Vary/content-length/content-disposition/baseline CSP, ETag + 304, format negotiation (including through a real srvx server, since the request now reaches ipx unwrapped), and upstream failures with their re-stated bodies (404 missing source, 400 undecodable source, 403 blocked private IP — each asserting the plain-text message rather than only the status, which is what pins the ipx JSON out of the response). A trailing `describe` re-imports the module under `vi.doMock("ipx")` to exercise the unoptimized fallback (warn-once, non-image upstream, forwarded upstream status, unreachable-upstream 502, baseline CSP, 405, 503 with no address)
- Test fixture in `test/fixtures/app-headers.mjs` — Entry that echoes all request headers as JSON for vercel header injection tests
- Test fixture in `test/fixtures/app-env.mjs` — Entry that echoes request headers and selected environment variables as JSON
- Test fixture in `test/fixtures/app-image.mjs` — Entry that serves a 1x1 PNG at `/test.png` for the vercel image wiring tests
