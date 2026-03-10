import { runtime } from "std-env";

export default {
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/env") {
      return Response.json({
        runtime,
      });
    }

    if (url.pathname === "/echo") {
      return request.text().then((body) => {
        return Response.json({ body, method: request.method });
      });
    }

    return new Response("ok");
  },
};
