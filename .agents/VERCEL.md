# VercelEnvRunner

Extends `NodeWorkerEnvRunner`; the worker sets up Vercel globals/env, then imports the node-worker worker.

## Worker environment

- Defaults (only when unset): `VERCEL=1`, `VERCEL_ENV=development`, `NODE_ENV=development` (gates `@vercel/queue` dev mode). Scoped to the worker thread's own env copy
- `VERCEL_REGION`/`NOW_REGION` are intentionally **not** defaulted: Vercel SDKs expect valid region identifiers when set
- `globalThis[Symbol.for("@vercel/request-context")]` for `@vercel/functions`: in-memory `cache` (TTL + tags, lives as long as the worker), `purge` no-ops, `addCacheTag`, `waitUntil` (tracked, never awaited)

## OIDC

- Constructor checks `VERCEL_OIDC_TOKEN` by decoding the JWT `exp` claim only (no signature check) and warns once per process if missing/expired/malformed, suggesting `vercel env pull`

## Header injection

All headers are set only when absent, so caller-provided values win.

- Request:
  - `x-vercel-deployment-url` — `http://<host>:<port>` of the worker, only once the address is known (a fetch before ready lacks it)
  - `x-vercel-id` — `dev1::<podId>-<ts36>-<hex>`, podId stable per host process (matches `vercel dev`)
  - Client IP = first `x-forwarded-for` entry, else `x-real-ip`, else `127.0.0.1`; fills `x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip`
  - `x-forwarded-proto` from the URL, `x-forwarded-host` from `host` header or URL
- Response: `server: Vercel`, `x-vercel-id` (same id as the request), `x-vercel-cache: MISS`

## Local Vercel Queues (`env-runner/runners/vercel/queue-dev`)

- Frameworks inside the worker `await registerVercelQueueConsumer({ sdk, topic, handler, ... })` (e.g. Nitro forwards to its `vercel:queue` hook); resolves to an unregister fn
- `sdk` follows the runtime-dep contract; the omitted-option optional import is memoized once per process
- One `QueueClient` per SDK instance; the SDK's `registerDevConsumer` does delivery
- Re-registering the same `consumerGroup` (default `env-runner-vercel-dev`) on a topic replaces the handler (HMR-safe; the replaced registration's unregister becomes a no-op). Use distinct groups to fan out
- `retryAfterSeconds` is shorthand for `retry: () => ({ afterSeconds })`; an explicit `retry` wins
- No SDK, or one without `registerDevConsumer` (< 0.2.0) → one-time warning and no-op unregister; dev startup is never blocked
- Local metadata/handler/retry types mirror the SDK's, so there is no type import from `@vercel/queue`

## Testing

- `test/vercel.test.ts` — header injection/preservation and worker env. Suites (and the Vercel case in `runners.test.ts`) stub a far-future `VERCEL_OIDC_TOKEN` via `vi.stubEnv` to silence the warning; vitest's `NODE_ENV=test` is inherited, so the default isn't observable
- `test/vercel-queue.test.ts` — fake `sdk` objects plus a specifier stub (`test/fixtures/queue-sdk-stub.mjs`); a typecheck-only assertion keeps the real `@vercel/queue` module assignable to `VercelQueueSdk`
