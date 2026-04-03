let sendMessage;

export default {
  async fetch(request) {
    const url = new URL(request.url);

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
