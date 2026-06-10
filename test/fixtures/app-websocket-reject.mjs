export default {
  fetch() {
    return new Response("ok");
  },
  websocket: {
    upgrade() {
      // Reject the upgrade by returning a non-101 response.
      throw new Response("Unauthorized", { status: 401 });
    },
    open(peer) {
      peer.send("welcome");
    },
    message(peer, message) {
      peer.send(`echo:${message.text()}`);
    },
  },
};
