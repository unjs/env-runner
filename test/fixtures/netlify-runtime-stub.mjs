// Stands in for `@netlify/runtime` in tests: records the options the worker
// passed to `startRuntime()` so the `netlifyRuntime` injection is observable.
export function startRuntime(options) {
  globalThis.__envRunnerNetlifyRuntimeStub = {
    deployID: options.deployID,
    siteID: options.siteID,
    hasGetRequestContext: typeof options.getRequestContext === "function",
    hasCacheContext: typeof options.cache?.getCacheAPIContext === "function",
  };
  globalThis.Netlify = { context: null, env: options.env };
}
