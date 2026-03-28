import type { WorkerHooks } from "../../types.ts";

import { fileURLToPath } from "node:url";

import type { EnvRunnerData } from "../../common/base-runner.ts";
import { NodeWorkerEnvRunner } from "../node-worker/runner.ts";

export type { EnvRunnerData };

let _defaultEntry: string;

export class NetlifyEnvRunner extends NodeWorkerEnvRunner {
  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/netlify/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
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
