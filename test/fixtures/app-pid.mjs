export default {
  fetch() {
    return new Response(String(process.pid));
  },
};
