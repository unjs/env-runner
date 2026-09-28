export default {
  transform: {
    order: "post",
    handler(code, _id, meta) {
      globalThis.__pluginCalls.push(
        `post:${meta.moduleType}:${code.includes(": number") ? "typed" : "untyped"}`,
      );
    },
  },
};
