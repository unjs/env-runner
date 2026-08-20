export default {
  fetch() {
    const N = globalThis.Netlify;
    return Response.json({
      hasNetlify: typeof N === "object" && N !== null,
      envGet: typeof N?.env?.get,
      envReadsProcessEnv: N?.env?.get("ENV_RUNNER_NETLIFY_TEST") ?? null,
      // Set only by the stub runtime fixture, so tests can tell whether the
      // `netlifyRuntime` specifier was actually imported and started.
      startedRuntime: globalThis.__envRunnerNetlifyRuntimeStub ?? null,
    });
  },
};
