// Records the non-fetch handlers it is called with, served back by `fetch`.
const calls = [];

const internalBindings = (env) => Object.keys(env).filter((key) => key.startsWith("__ENV_RUNNER"));

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/send") {
      await env.QUEUE.send({ hello: "queue" });
      return new Response("sent");
    }
    return Response.json(calls);
  },
  scheduled(controller, env, ctx) {
    calls.push({
      handler: "scheduled",
      cron: controller.cron,
      internalBindings: internalBindings(env),
      waitUntil: typeof ctx.waitUntil,
    });
  },
  queue(batch, env) {
    calls.push({
      handler: "queue",
      queue: batch.queue,
      messages: batch.messages.map((message) => message.body),
      internalBindings: internalBindings(env),
    });
  },
};
