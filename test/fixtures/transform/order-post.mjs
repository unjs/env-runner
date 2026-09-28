export default {
  transform: {
    order: "post",
    handler(code, _id, meta) {
      globalThis.__transformCalls.push(
        `post:${meta.moduleType}:${code.includes(": number") ? "typed" : "untyped"}`,
      );
    },
  },
};
