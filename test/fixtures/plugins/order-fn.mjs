// Unordered plugin: runs in list order among unordered ones.
export default {
  transform(code, _id, meta) {
    globalThis.__pluginCalls.push(
      `normal:${meta.moduleType}:${code.includes(": number") ? "typed" : "untyped"}`,
    );
  },
};
