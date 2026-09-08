import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import * as miniflare from "miniflare";
import { serve } from "srvx/node";
import { MiniflareEnvRunner } from "../src/runners/miniflare/runner.ts";

const url = "http://localhost/echo";
const init = {
  method: "POST",
  headers: { cookie: "session=alice", authorization: "Bearer sample" },
  body: "payload",
};
const expected = {
  method: "POST",
  cookie: "session=alice",
  authorization: "Bearer sample",
  body: "payload",
};

describe("Miniflare Request inputs", () => {
  let runner: MiniflareEnvRunner;
  let forwarded: RequestInit | undefined;
  beforeAll(async () => {
    runner = new MiniflareEnvRunner({
      name: "request-input",
      miniflare: {
        ...miniflare,
        Miniflare: class extends miniflare.Miniflare {
          constructor(options: ConstructorParameters<typeof miniflare.Miniflare>[0]) {
            super(options);
            const dispatch = this.dispatchFetch;
            this.dispatchFetch = (input, init) => {
              forwarded = init as RequestInit;
              return dispatch(input, init);
            };
          }
        },
      },
      data: { entry: fileURLToPath(new URL("./fixtures/app-request.mjs", import.meta.url)) },
    });
    await runner.waitForReady();
  });
  afterAll(async () => {
    await runner?.close();
  });

  test.each(["string", "URL", "relative", "Request"])("preserves %s input", async (kind) => {
    const input =
      kind === "Request"
        ? new Request(url, init)
        : kind === "URL"
          ? new URL(url)
          : kind === "relative"
            ? "/echo"
            : url;
    expect(await (await runner.fetch(input, kind === "Request" ? undefined : init)).json()).toEqual(
      expected,
    );
  });
  test("preserves a non-default referrer and its override", async () => {
    const request = new Request(url, {
      referrer: "http://localhost/source",
      referrerPolicy: "unsafe-url",
    });
    await (await runner.fetch(request)).text();
    expect(forwarded?.referrer).toBe("http://localhost/source");
    expect(forwarded?.referrerPolicy).toBe("unsafe-url");
    const override = new Request(url, {
      referrer: "http://localhost/source",
      referrerPolicy: "unsafe-url",
    });
    await (await runner.fetch(override, { referrer: "http://localhost/override" })).text();
    expect(forwarded?.referrer).toBe("http://localhost/override");
  });

  test("honors explicit overrides and ignores undefined fields", async () => {
    expect(
      await (
        await runner.fetch(new Request(url, init), { method: undefined, headers: undefined })
      ).json(),
    ).toEqual(expected);
    expect(
      await (
        await runner.fetch(new Request(url, init), {
          method: "PUT",
          headers: { cookie: "override" },
          body: "replacement",
        })
      ).json(),
    ).toEqual({ method: "PUT", cookie: "override", authorization: null, body: "replacement" });
  });
  test("preserves HEAD and isolates concurrent credentials", async () => {
    expect(await (await runner.fetch(new Request(url, { method: "HEAD" }))).text()).toBe("");
    const values = await Promise.all(
      ["alice", "bob"].map(
        async (cookie) =>
          (await (await runner.fetch(new Request(url, { headers: { cookie } }))).json()).cookie,
      ),
    );
    expect(values).toEqual(["alice", "bob"]);
  });
  test("forwards streaming srvx NodeRequest inputs", async () => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      silent: true,
      fetch: (request) => runner.fetch(request),
    });
    await server.ready();
    try {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"));
          controller.close();
        },
      });
      expect(
        await (await fetch(server.url!, { ...init, body, duplex: "half" } as RequestInit)).json(),
      ).toEqual(expected);
    } finally {
      await server.close(true);
    }
  });
  test("preserves an aborted Request signal", async () => {
    await expect(
      runner.fetch(new Request(url, { signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
