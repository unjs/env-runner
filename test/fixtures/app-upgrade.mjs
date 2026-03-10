import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-5AB5DC11E5B4";

export default {
  fetch(_req) {
    return new Response("ok");
  },
  upgrade(context) {
    const { req, socket } = context.node;
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "X-Upgraded: true",
        "",
        "",
      ].join("\r\n"),
    );
  },
};
