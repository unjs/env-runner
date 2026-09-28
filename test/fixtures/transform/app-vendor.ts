// @ts-nocheck -- CommonJS default imports
import dep from "./cjs/dep.cts";
import vendor from "./cjs/vendor/plain.ts";

export default {
  fetch: () => Response.json([dep.value, vendor.value]),
};
