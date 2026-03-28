import type { WorkerHooks } from "../../types.ts";

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { EnvRunnerData } from "../../common/base-runner.ts";
import { NodeWorkerEnvRunner } from "../node-worker/runner.ts";

export type { EnvRunnerData };

let _defaultEntry: string;

// Stable per-instance pod ID (5-char base32), matches vercel dev behavior
const _podId = Math.random().toString(32).slice(-5);

function generateVercelId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(6).toString("hex");
  return `dev1::${_podId}-${timestamp}-${random}`;
}

export class VercelEnvRunner extends NodeWorkerEnvRunner {
  constructor(opts: {
    name: string;
    workerEntry?: string;
    hooks?: WorkerHooks;
    data?: EnvRunnerData;
  }) {
    _defaultEntry ||= fileURLToPath(import.meta.resolve("env-runner/runners/vercel/worker"));
    super({ ...opts, workerEntry: opts.workerEntry || _defaultEntry });
  }

  override async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    const requestId = generateVercelId();

    if (this._address && this._address.port != null && !headers.has("x-vercel-deployment-url")) {
      const host = this._address.host || "127.0.0.1";
      headers.set("x-vercel-deployment-url", `http://${host}:${this._address.port}`);
    }

    if (!headers.has("x-vercel-id")) {
      headers.set("x-vercel-id", requestId);
    }

    const clientIp =
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers.get("x-real-ip") ||
      "127.0.0.1";

    if (!headers.has("x-vercel-forwarded-for")) {
      headers.set("x-vercel-forwarded-for", clientIp);
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

    let res: Response;
    if (input instanceof Request) {
      res = await super.fetch(new Request(input, { ...init, headers }));
    } else {
      res = await super.fetch(input, { ...init, headers });
    }

    // Inject Vercel response headers
    const resHeaders = new Headers(res.headers);
    if (!resHeaders.has("server")) {
      resHeaders.set("server", "Vercel");
    }
    if (!resHeaders.has("x-vercel-id")) {
      resHeaders.set("x-vercel-id", requestId);
    }
    if (!resHeaders.has("x-vercel-cache")) {
      resHeaders.set("x-vercel-cache", "MISS");
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  }

  protected override _runtimeType() {
    return "vercel";
  }
}
