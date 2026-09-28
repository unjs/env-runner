// Counts its own runs: `__COUNT__` becomes the number of transforms so far.
let count = 0;
export default {
  transform: (code) =>
    code.includes("__COUNT__") ? code.replace("__COUNT__", String(++count)) : undefined,
};
