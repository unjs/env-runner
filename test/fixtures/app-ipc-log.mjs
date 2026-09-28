// Records every message reaching `ipc.onMessage`, so tests can assert that the
// worker's internal init-data handshake never leaks into the entry.
const received = [];
let sendMessage;

export default {
  fetch() {
    return new Response("ok");
  },
  ipc: {
    onOpen(ctx) {
      sendMessage = ctx.sendMessage;
    },
    onMessage(message) {
      received.push(message);
      if (message?.type === "ipc-log") {
        sendMessage?.({ type: "ipc-log-reply", received });
      }
    },
  },
};
