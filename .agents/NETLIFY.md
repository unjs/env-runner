# NetlifyEnvRunner

Extends `NodeWorkerEnvRunner` to simulate a Netlify deployment environment.

## Source files

- **`src/runners/netlify/runner.ts`** — `NetlifyEnvRunner` extends `NodeWorkerEnvRunner`: simulates Netlify deployment environment with header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`). Exports `NetlifyEnvRunnerOptions`, which adds `netlifyRuntime?: string | URL | false` — see "Netlify runtime injection"
- **`src/runners/netlify/worker.ts`** — Resolves the `workerData.netlifyRuntime` specifier (or, with none given, `@netlify/runtime` itself) through the shared `resolveRuntimeDep()` with `expect: "startRuntime"` and calls `startRuntime()` (sets up `globalThis.Netlify` with env/context and `globalThis.caches`); falls back to a lightweight `globalThis.Netlify` shim when the import fails or `netlifyRuntime` is `false`. Delegates to node-worker worker

## How it works

Extends `NodeWorkerEnvRunner` to simulate a Netlify deployment environment. The worker sets `globalThis.Netlify` with `context` (null) and `env` (backed by `process.env`) for Netlify Functions API compatibility, then delegates to the node-worker worker.

**Netlify runtime injection:** `@netlify/runtime` is **not a dependency** (not even an optional peer one). `startRuntime()` must run inside the worker thread, where a live module instance cannot be handed over, so this is the one runtime-dependency option that does **not** accept an imported module: `netlifyRuntime?: string | URL | false`. `resolveNetlifyRuntime()` (bottom of `runner.ts`) delegates to the shared `resolveRuntimeDepSpecifier()` (`src/common/runtime-deps.ts`), which normalizes it on the host — a `URL` or URL-like string passes through, anything else is resolved with exsolve's `resolveModulePath(spec, { from: cwd, try: true })` and converted to a `file://` href (the worker's own resolution base is inside `env-runner`, not the user's project); an unresolvable specifier is passed through verbatim so the worker's import error names the real reason, and an imported module throws an actionable `TypeError` pointing at `import.meta.resolve()`. The resolved value is merged into `data` as `data.netlifyRuntime`, reaching the worker via `workerData`; `false` is forwarded verbatim to force the shim, and `undefined` leaves the key off so the worker falls back to its own optional import of `@netlify/runtime`. A failed import installs the shim (so a missing package never blocks dev startup) and — only when a specifier was given explicitly, since a missing optional package is the expected path — logs `[env-runner] failed to start the Netlify runtime from "<spec>": <message>` on the worker's forwarded stderr.

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

- **`test/netlify.test.ts`** — Tests for `NetlifyEnvRunner`: header injection (`x-nf-client-connection-ip`, `x-nf-account-id`, `x-nf-site-id`, `x-nf-deploy-id`, `x-nf-deploy-context`, `x-nf-geo`, `x-nf-request-id`), IP derivation, header preservation, and `netlifyRuntime` injection — shim with `netlifyRuntime: false`, optional import of `@netlify/runtime` when the option is omitted, `startRuntime()` called with the expected options when a specifier is given (asserted through a stub module, since the real runtime's observable globals are indistinguishable from the shim's under Node worker threads), bare-specifier resolution from the cwd against the real `@netlify/runtime`, and shim fallback for an unimportable specifier
- Test fixtures: `test/fixtures/app-netlify.mjs` (echoes the worker's `globalThis.Netlify` shape + the stub's marker) and `test/fixtures/netlify-runtime-stub.mjs` (stands in for `@netlify/runtime`, recording the `startRuntime()` options)
- Shares the `test/fixtures/app-headers.mjs` / `test/fixtures/app-env.mjs` fixtures (see [`VERCEL.md`](VERCEL.md))

> Worker-entry changes need `pnpm build` before tests exercise them: runners resolve their default worker through `import.meta.resolve("env-runner/runners/<name>/worker")`, which maps to `dist/`.
