export default {
  fetch(request) {
    const headers = {};
    for (const [key, value] of request.headers) {
      headers[key] = value;
    }
    return Response.json(headers);
  },
};
