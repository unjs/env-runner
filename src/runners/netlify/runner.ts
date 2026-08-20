import type { WorkerHooks } from "../../types.ts";

import { fileURLToPath } from "node:url";
import { resolveRuntimeDepSpecifier } from "../../common/runtime-deps.ts";

import type { EnvRunnerData } from "../../common/base-runner.ts";
import { NodeWorkerEnvRunner } from "../node-worker/runner.ts";

export type { EnvRunnerData };

let _defaultEntry: string;

export interface NetlifyEnvRunnerOptions {
  name: string;
  workerEntry?: string;
  hooks?: WorkerHooks;
  data?: EnvRunnerData;
  /**
   * Module specifier for the `@netlify/runtime` package, used inside the
   * worker to call `startRuntime()` (full `globalThis.Netlify` + `caches`
   * setup). `env-runner` does not depend on `@netlify/runtime`.
   *
   * Unlike the other runtime-dependency options, this one takes a **specifier
   * only**: the runtime has to be instantiated inside the worker thread, and a
   * live module instance cannot cross that boundary.
   *
   * ```ts
   * new NetlifyEnvRunner({
   *   name: "app",
   *   netlifyRuntime: import.meta.resolve("@netlify/runtime"),
   *   data: { entry },
   * });
   * ```
   *
   * A bare specifier (e.g. `"@netlify/runtime"`) is resolved from the current
   * working directory. When omitted, the worker tries
   * `import("@netlify/runtime")` and falls back to a lightweight
   * `globalThis.Netlify` shim (env access only) if it isn't installed. Pass
   * `false` to always use the shim.
   */
  netlifyRuntime?: string | URL | false;
}

export class NetlifyEnvRunner extends NodeWorkerEnvRunner {
  constructor(opts: NetlifyEnvRunnerOptions) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/netlify/worker"));
    const netlifyRuntime = resolveNetlifyRuntime(opts.netlifyRuntime);
    super({
      ...opts,
      workerEntry: opts.workerEntry || _defaultEntry,
      data: netlifyRuntime === undefined ? opts.data : { ...opts.data, netlifyRuntime },
    });
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    input = this._resolveFetchInput(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    const clientIp =
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers.get("x-real-ip") ||
      "127.0.0.1";

    if (!headers.has("x-nf-client-connection-ip")) {
      headers.set("x-nf-client-connection-ip", clientIp);
    }

    if (!headers.has("x-nf-account-id")) {
      headers.set("x-nf-account-id", "0");
    }

    if (!headers.has("x-nf-site-id")) {
      headers.set("x-nf-site-id", "0");
    }

    if (!headers.has("x-nf-deploy-id")) {
      headers.set("x-nf-deploy-id", "0");
    }

    if (!headers.has("x-nf-deploy-context")) {
      headers.set("x-nf-deploy-context", "dev");
    }

    if (!headers.has("x-nf-geo")) {
      headers.set(
        "x-nf-geo",
        btoa(JSON.stringify({ city: "localhost", country: { code: "dev" } })),
      );
    }

    if (!headers.has("x-nf-request-id")) {
      headers.set("x-nf-request-id", crypto.randomUUID());
    }

    if (!headers.has("x-forwarded-for")) {
      headers.set("x-forwarded-for", clientIp);
    }
    if (!headers.has("x-real-ip")) {
      headers.set("x-real-ip", clientIp);
    }

    try {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!headers.has("x-forwarded-proto")) {
        headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
      }
      if (!headers.has("x-forwarded-host")) {
        headers.set("x-forwarded-host", headers.get("host") || url.host);
      }
    } catch {
      // URL parsing failed, skip proto/host headers
    }

    if (input instanceof Request) {
      return super.fetch(new Request(input, { ...init, headers }));
    }
    return super.fetch(input, { ...init, headers });
  }

  protected override _runtimeType() {
    return "netlify";
  }
}

/**
 * Normalize the `netlifyRuntime` option into an absolute specifier the worker
 * thread can import (its own resolution base is inside `env-runner`, not the
 * user's project). Unresolvable specifiers are passed through as-is so the
 * worker's own import error surfaces the real reason.
 */
function resolveNetlifyRuntime(
  runtime: string | URL | false | undefined,
): string | false | undefined {
  // `false` reaches the worker as-is (force the shim); `undefined` lets the
  // worker try its own optional `@netlify/runtime` import. Anything else is
  // resolved to an absolute specifier the worker can import, since a bare one
  // would otherwise resolve against env-runner rather than the app.
  return resolveRuntimeDepSpecifier(runtime, "netlifyRuntime");
}
