export default {
  fetch() {
    return new Response(
      /* js */ `<!DOCTYPE html>
<html>
<body>
<pre id="log"></pre>
<script>
const ws = new WebSocket("ws://" + location.host + "/_ws");
const log = document.getElementById("log");
ws.onopen = () => log.textContent += "connected\\n";
ws.onmessage = (e) => log.textContent += e.data + "\\n";
ws.onclose = () => log.textContent += "disconnected\\n";
</script>
</body>
</html>`,
      { headers: { "content-type": "text/html" } },
    );
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
