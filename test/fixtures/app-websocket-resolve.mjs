// `websocket: { resolve }`, as Nitro exports it.
const hooks = {
  open(peer) {
    peer.send("welcome");
  },
  message(peer, message) {
    peer.send(`echo:${message.text()}`);
  },
};

export default {
  fetch() {
    return new Response("ok");
  },
  websocket: {
    resolve: () => hooks,
  },
};
