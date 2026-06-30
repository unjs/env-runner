/**
 * Thin indirection for importing the optional `wrangler` package.
 *
 * `loadWranglerConfig()` calls this instead of `import("wrangler")` directly so
 * the "wrangler not installed" fallback path can be exercised deterministically
 * in tests: mocking a local module we own is reliable across environments,
 * whereas mocking an externalized node_modules package through a dynamic import
 * depends on whether the test runner inlines or externalizes it.
 */
export function importWrangler(): Promise<any> {
  return import("wrangler");
}
