// Plugin factory: runs after oxc (listed after it), on plain JS.
export default (options = {}) => ({
  name: "greeting",
  transform: (code) => code.replaceAll("__GREETING__", JSON.stringify(options.greeting ?? "hi")),
});
