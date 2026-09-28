import { value } from "./.hidden/value.ts";
import { value as vendor } from "./vendor/plain.ts";

export default {
  fetch: () => Response.json([value, vendor]),
};
