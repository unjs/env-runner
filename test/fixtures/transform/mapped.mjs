// Custom transformer returning its own (identity-like) source map.
export default (code) => ({
  code,
  map: { version: 3, mappings: "AAAA", names: [], sources: ["input"] },
});
