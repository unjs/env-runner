// Responds after `?delay=<ms>`, past Bun's default 10s `idleTimeout`.
export default {
  async fetch(request) {
    const delay = Number(new URL(request.url).searchParams.get("delay") || 0);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response(`ok after ${delay}ms`);
  },
};
