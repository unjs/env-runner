# NetlifyEnvRunner

Extends `NodeWorkerEnvRunner`; the worker sets up `globalThis.Netlify`, then imports the node-worker worker.

## Netlify runtime (`netlifyRuntime?: string | URL | false`)

- **Specifier only**: `startRuntime()` must run inside the worker thread, and a live module instance can't cross that boundary. Passing an imported module throws a `TypeError` pointing at `import.meta.resolve()`
- Resolved on the host from cwd to a `file://` href, because the worker's own resolution base is inside `env-runner`, not the app. Unresolvable specifiers pass through verbatim so the worker's import error names the real cause
- Omitted → the worker tries `@netlify/runtime` optionally; `false` → always the shim
- On success `startRuntime()` sets up `globalThis.Netlify` + `globalThis.caches` (deploy/site id `"0"`, env backed by `process.env`, null request context)
- On failure, or with `false`, a shim is installed: `globalThis.Netlify = { context: null, env }` (no `caches`). A failed import warns on stderr only when a specifier was given explicitly (a missing optional package is the expected path)

## Header injection

Request headers only, each set only when absent:

- `x-nf-client-connection-ip` — first `x-forwarded-for` entry, else `x-real-ip`, else `127.0.0.1` (also fills `x-forwarded-for`/`x-real-ip`)
- `x-nf-account-id`/`x-nf-site-id`/`x-nf-deploy-id` `"0"`, `x-nf-deploy-context` `dev`
- `x-nf-geo` — base64 JSON `{ city: "localhost", country: { code: "dev" } }`
- `x-nf-request-id` — `crypto.randomUUID()`
- `x-forwarded-proto` from the URL, `x-forwarded-host` from `host` header or URL

## Testing

- `test/netlify.test.ts` — headers and `netlifyRuntime` resolution. `startRuntime()` is asserted through a stub module (`test/fixtures/netlify-runtime-stub.mjs`) because the real runtime's observable globals are indistinguishable from the shim's under Node worker threads; the bare-specifier case uses the real `@netlify/runtime` devDependency
