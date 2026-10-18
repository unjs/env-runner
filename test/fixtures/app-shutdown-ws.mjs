// Graceful shutdown with a WebSocket still open: `ipc.onClose` must still run.
let sendMessage;

export default {
  fetch() {
    return new Response("ok");
  },
  websocket: {
    open(peer) {
      peer.send("welcome");
    },
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
