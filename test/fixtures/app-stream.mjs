// Streams `<id>:start`, then `:end` after `?delay=<ms>` (`id` identifies the worker).
const id = Math.random().toString(36).slice(2);

export default {
  fetch(request) {
    const delay = Number(new URL(request.url).searchParams.get("delay") || 0);
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
