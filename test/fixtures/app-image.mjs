// Minimal 1x1 red PNG (base64-encoded)
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/test.png") {
      return new Response(PNG_1x1, {
        headers: { "content-type": "image/png" },
      });
    }
    return new Response("ok");
  },
};
