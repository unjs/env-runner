// Plugin factory: runs after oxc (listed after it), on plain JS. An `id` filter
// can come through the (JSON-serializable) options, e.g. `{ exclude: "**/vendor/**" }`.
export default ({ greeting = "hi", id } = {}) => ({
  name: "greeting",
  transform: {
    filter: id ? { id } : undefined,
    handler: (code) => code.replaceAll("__GREETING__", JSON.stringify(greeting)),
  },
});
