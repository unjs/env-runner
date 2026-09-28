// Plugin object: `pre` sees the TS/JSX source (before oxc); options arrive as `meta.options`.
export default {
  name: "greeting-plugin",
  transform: {
    order: "pre",
    filter: { id: "**/transform/**", code: "__GREETING__" },
    handler(code, _id, meta) {
      // Only the JSX expression: the source still has its `declare const`.
      const greeting = `${meta.options?.greeting ?? "hi"} from ${meta.moduleType}`;
      return code.replace("{__GREETING__}", `{${JSON.stringify(greeting)}}`);
    },
  },
};
