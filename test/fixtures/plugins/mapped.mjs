// Plugin returning its own source map.
export default {
  transform: (code) => ({
    code: `/* mapped */ ${code}`,
    map: { version: 3, mappings: "AAAA", names: [], sources: ["input"] },
  }),
};
