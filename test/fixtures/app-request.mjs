export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { location: "/echo" } });
    }
    return Response.json({
      method: request.method,
      cookie: request.headers.get("cookie"),
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
  },
};
