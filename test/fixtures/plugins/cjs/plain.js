// Untransformed CommonJS: on Bun, a glob-only `id` filter still sends it
// through the plugin `onLoad`, which must keep it CommonJS.
module.exports = { value: "plain" };
