// Graceful shutdown: `/slow` is still in flight when the host shuts the runner
// down; `ipc.onClose` must run after it responded.
let sendMessage;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/slow") {
      sendMessage?.({ type: "slow-started" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      sendMessage?.({ type: "slow-responded" });
      return new Response("slow");
    }
    return new Response("ok");
  },
  ipc: {
    onOpen(ctx) {
      sendMessage = ctx.sendMessage;
    },
    onClose() {
      sendMessage?.({ type: "ipc-closed" });
    },
  },
};
