// Custom transformer returning its own source map.
export default (code) => ({
  code: `/* mapped */ ${code}`,
  map: { version: 3, mappings: "AAAA", names: [], sources: ["input"] },
});
