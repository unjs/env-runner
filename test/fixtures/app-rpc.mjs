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
      // Handle RPC requests
      if (message?.__rpc && message.__rpc_id) {
        if (message.__rpc === "greet") {
          sendMessage?.({ __rpc_id: message.__rpc_id, data: `hello ${message.data}` });
        } else if (message.__rpc === "fail") {
          sendMessage?.({ __rpc_id: message.__rpc_id, error: "something went wrong" });
        } else if (message.__rpc === "slow") {
          setTimeout(() => {
            sendMessage?.({ __rpc_id: message.__rpc_id, data: "done" });
          }, 2000);
        }
      }
      // Also handle echo for backward compat
      if (message?.type === "ping") {
        sendMessage?.({ type: "pong", data: message.data });
      }
    },
    onClose() {
      sendMessage = undefined;
    },
  },
};
