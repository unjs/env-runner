export default {
  fetch() {
    return new Response("ok");
  },
  websocket: {
    open(peer) {
      peer.send("welcome");
    },
    message(peer, message) {
      peer.send(`echo:${message.text()}`);
    },
  },
};
