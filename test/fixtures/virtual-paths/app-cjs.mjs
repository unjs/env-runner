// Real entry importing a CommonJS sibling that tests override with a path key.
import legacy from "./legacy.cjs";

export default {
  fetch() {
    return new Response(legacy);
  },
};
