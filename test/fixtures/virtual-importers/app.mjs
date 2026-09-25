// Disk entry reaching `#count` only through disk modules (`./lib.mjs` →
// `./deep.mjs`). `./unrelated.mjs` imports no virtual module.
import { count } from "./lib.mjs";
import "./unrelated.mjs";

export default {
  fetch() {
    return Response.json({ count, evaluations: globalThis.__evaluations });
  },
};
