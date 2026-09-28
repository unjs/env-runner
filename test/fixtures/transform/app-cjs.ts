// @ts-nocheck -- CommonJS default imports
import lib from "./cjs/lib.ts";
import dep from "./cjs/dep.cts";

export default {
  fetch: () => Response.json([lib.value, dep.value]),
};
