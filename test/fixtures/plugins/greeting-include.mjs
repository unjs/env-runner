// `greeting.mjs` with a case-insensitive `id` filter leaving out `cjs/vendor/plain.ts`.
export default {
  name: "greeting-include",
  transform: {
    filter: { id: /\/PLUGINS\/(?:app-vendor\.ts|cjs\/dep\.cts)$/i },
    handler: (code) => code.replaceAll("__GREETING__", JSON.stringify("hi")),
  },
};
