# VercelEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Vercel deployment environment.

## Source files

- **`src/runners/vercel/runner.ts`** — `VercelEnvRunner` extends `NodeWorkerEnvRunner`: simulates Vercel deployment environment with header injection
- **`src/runners/vercel/worker.ts`** — Sets Vercel env vars and `Symbol.for("@vercel/request-context")` on globalThis, delegates to node-worker worker
- **`src/runners/vercel/oidc.ts`** — `_checkVercelOidcToken()` decodes `VERCEL_OIDC_TOKEN` (JWT `exp` claim, no signature check) and returns `{ status: "missing" | "valid" | "expired" | "invalid", expiresAt? }`. `warnIfVercelOidcTokenInvalid()` logs a one-time dev warning hinting the user to run `vercel env pull`. Called from the `VercelEnvRunner` constructor
- **`src/runners/vercel/queue-dev.ts`** — Bridge for local Vercel Queues delivery. `await registerVercelQueueConsumer({ topic, handler, consumerGroup?, visibilityTimeoutSeconds?, retry?, retryAfterSeconds? })` lets framework plugins bind a topic to a dispatcher; the first call lazy-loads `@vercel/queue` and constructs a shared `QueueClient`. Resolves to an unregister function. Re-registering the same `consumerGroup` on a topic replaces the handler via the SDK's own `consumerGroup` keying (HMR-safe; the unregister for a replaced registration becomes a no-op). `retryAfterSeconds` is a shorthand for `retry: () => ({ afterSeconds })`; pass `retry` for richer directives like `{ acknowledge: true }`

## How it works

Extends `NodeWorkerEnvRunner` to simulate a Vercel deployment environment. The worker sets `Symbol.for("@vercel/request-context")` on `globalThis` (with `waitUntil`, `cache`, `purge`, `addCacheTag`) for `@vercel/functions` compatibility, sets Vercel environment variables, then delegates to the node-worker worker.

**Environment variables** (set in worker thread, won't override if already set):

- `VERCEL` — `"1"`
- `VERCEL_ENV` — `"development"`
- `NODE_ENV` — `"development"` (gates `@vercel/queue`'s dev mode and other framework dev paths)

`VERCEL_REGION` and `NOW_REGION` are intentionally not defaulted — Vercel SDKs rely on them being valid region identifiers when set, so they must be explicitly provided if required.

**Request header injection:** Overrides `fetch()` to inject Vercel-specific headers before delegating to the parent:

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

## Testing

- Vercel suites (`test/vercel.test.ts` and the Vercel entry in `test/runners.test.ts`) stub a fake far-future `VERCEL_OIDC_TOKEN` via `vi.stubEnv` so the OIDC check doesn't log warnings (real env token takes precedence)
- **`test/vercel.test.ts`** — Tests for `VercelEnvRunner`: request header injection (`x-vercel-deployment-url`, `x-vercel-id`, `x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-proto`, `x-forwarded-host`), response header injection (`server`, `x-vercel-id`, `x-vercel-cache`), environment variables (`VERCEL`, `VERCEL_ENV`, `VERCEL_REGION`, `NOW_REGION`), header preservation, pre-existing header respect
- Test fixture in `test/fixtures/app-headers.mjs` — Entry that echoes all request headers as JSON for vercel header injection tests
- Test fixture in `test/fixtures/app-env.mjs` — Entry that echoes request headers and selected environment variables as JSON
