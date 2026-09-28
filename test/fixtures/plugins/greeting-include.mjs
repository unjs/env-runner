// The greeting plugin with a case-insensitive `id` RegExp leaving out `vendor/plain.ts`.
export default {
  name: "greeting-include",
  transform: {
    filter: { id: /\/PLUGINS\/(?:app-vendor\.ts|cjs\/dep\.cts)$/i },
    handler: (code) => code.replaceAll("__GREETING__", JSON.stringify("hi")),
  },
};
