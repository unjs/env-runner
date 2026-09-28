// Real entry importing a sibling that tests override with a path-keyed virtual module.
import config from "./config.mjs";

export default {
  fetch() {
    return new Response(config);
  },
};
