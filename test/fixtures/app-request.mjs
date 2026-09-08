export default {
  async fetch(request) {
    return Response.json({
      method: request.method,
      cookie: request.headers.get("cookie"),
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
  },
};
