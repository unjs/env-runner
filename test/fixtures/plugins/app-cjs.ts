// @ts-nocheck -- CommonJS default imports
import lib from "./cjs/lib.ts";
import dep from "./cjs/dep.cts";
import plain from "./cjs/plain.js";

export default {
  fetch: () => Response.json([lib.value, dep.value, plain.value]),
};
