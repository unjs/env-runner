# NetlifyEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Netlify deployment environment.

## Source files

- **`src/runners/netlify/runner.ts`** — `NetlifyEnvRunner` extends `NodeWorkerEnvRunner`: simulates Netlify deployment environment with header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`)
- **`src/runners/netlify/worker.ts`** — Uses `@netlify/runtime` `startRuntime()` when available (sets up `globalThis.Netlify` with env/context and `globalThis.caches`), falls back to lightweight shim. Delegates to node-worker worker

## How it works

Extends `NodeWorkerEnvRunner` to simulate a Netlify deployment environment. The worker sets `globalThis.Netlify` with `context` (null) and `env` (backed by `process.env`) for Netlify Functions API compatibility, then delegates to the node-worker worker.

**Header injection:** Overrides `fetch()` to inject Netlify-specific headers before delegating to the parent:

- `x-nf-client-connection-ip` — derived from `x-forwarded-for` (first IP) or `x-real-ip`, defaults to `127.0.0.1`
- `x-nf-account-id` — defaults to `"0"`
- `x-nf-site-id` — defaults to `"0"`
- `x-nf-deploy-id` — defaults to `"0"`
- `x-nf-deploy-context` — defaults to `"dev"`
- `x-nf-geo` — base64-encoded JSON geolocation object, defaults to `{ city: "localhost", country: { code: "dev" } }`
- `x-nf-request-id` — unique UUID per request via `crypto.randomUUID()`
- `x-forwarded-for`, `x-real-ip` — set to client IP if not already present
- `x-forwarded-proto` — protocol from request URL
- `x-forwarded-host` — from `host` header or request URL

All headers are only injected when not already present in the request.

## Testing

- **`test/netlify.test.ts`** — Tests for `NetlifyEnvRunner`: header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`), IP derivation, header preservation
- Shares the `test/fixtures/app-headers.mjs` / `test/fixtures/app-env.mjs` fixtures (see [`VERCEL.md`](VERCEL.md))
