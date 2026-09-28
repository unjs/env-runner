// @ts-nocheck -- CommonJS default import
import dep from "./cjs/dep.cts";
import { value } from "./vendor/plain.ts";

export default {
  fetch: () => Response.json([dep.value, value]),
};
