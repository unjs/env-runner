// Sends IPC messages from contexts that outlive the wrapper's fetch() call.
let send;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trySend(tag) {
  try {
    send({ type: "sent", tag });
    return "ok";
  } catch (error) {
    return `error: ${error.message}`;
  }
}

export default {
  ipc: {
    onOpen(ctx) {
      send = ctx.sendMessage;
    },
  },
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/slow") {
      await sleep(300);
      return new Response(trySend("slow"));
    }
    if (pathname === "/stream") {
      const body = new ReadableStream({
        async start(controller) {
          await sleep(100);
          controller.enqueue(new TextEncoder().encode(trySend("stream")));
          controller.close();
        },
      });
      return new Response(body);
    }
    return new Response(trySend("fast"));
  },
};
