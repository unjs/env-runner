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
   * `@netlify/runtime` specifier (resolved from cwd), imported inside the worker
   * since a module instance can't cross into it. Omitted: imported optionally,
   * else an env-only `globalThis.Netlify` shim. `false` forces the shim.
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

/** Resolve from the app: the worker's own resolution base is inside `env-runner`. */
function resolveNetlifyRuntime(
  runtime: string | URL | false | undefined,
): string | false | undefined {
  return resolveRuntimeDepSpecifier(runtime, "netlifyRuntime");
}
