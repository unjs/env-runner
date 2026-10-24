// Streams `<id>:start`, then `:end` after `?delay=<ms>` (`id` identifies the worker).
// `?wait=<ms>` delays the response, `?status=<code>` responds without a body and
// `?cookies` sets two cookies.
const id = Math.random().toString(36).slice(2);

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const wait = Number(params.get("wait") || 0);
    if (wait) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (params.has("status")) {
      return new Response(null, { status: Number(params.get("status")) });
    }
    if (params.has("cookies")) {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(id, { headers });
    }
    const delay = Number(params.get("delay") || 0);
    if (!delay) {
      return new Response(id);
    }
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`${id}:start`));
          await new Promise((resolve) => setTimeout(resolve, delay));
          controller.enqueue(encoder.encode(":end"));
          controller.close();
        },
      }),
    );
  },
  websocket: {
    message(peer, message) {
      peer.send(`${id}:${message.text()}`);
    },
  },
};
