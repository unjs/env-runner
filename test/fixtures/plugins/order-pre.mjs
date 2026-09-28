export default {
  transform: {
    order: "pre",
    handler(code, _id, meta) {
      globalThis.__pluginCalls.push(
        `pre:${meta.moduleType}:${code.includes(": number") ? "typed" : "untyped"}`,
      );
    },
  },
};
