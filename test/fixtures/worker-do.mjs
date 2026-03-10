// Worker with a Durable Object export to test that custom exports are preserved

export class Counter {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    let value = (await this.storage.get("count")) || 0;

    if (url.pathname === "/increment") {
      value++;
      await this.storage.put("count", value);
    }

    return Response.json({ count: value });
  }
}

let sendMessage;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/counter")) {
      const id = env.COUNTER.idFromName("test");
      const stub = env.COUNTER.get(id);
      // Forward with the sub-path so DO sees /increment
      const subPath = url.pathname.slice("/counter".length) || "/";
      return stub.fetch(new Request(new URL(subPath, url.origin), request));
    }

    if (url.pathname === "/echo") {
      const body = await request.text();
      return Response.json({ body, method: request.method });
    }

    return new Response("ok");
  },
  ipc: {
    onOpen(ctx) {
      sendMessage = ctx.sendMessage;
      sendMessage({ type: "ipc:opened" });
    },
    onMessage(message) {
      if (message?.type === "echo") {
        sendMessage?.({ type: "echo-reply", data: message.data });
      }
    },
    onClose() {
      sendMessage = undefined;
    },
  },
};
