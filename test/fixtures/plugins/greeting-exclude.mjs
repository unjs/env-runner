// `greeting.mjs` with an `id` filter excluding `/vendor/` paths.
export default {
  name: "greeting-exclude",
  transform: {
    filter: { id: { exclude: /\/vendor\// } },
    handler: (code) => code.replaceAll("__GREETING__", JSON.stringify("hi")),
  },
};
