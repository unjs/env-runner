// Extensionless: only a `fallback` plugin resolves it (not Bun, which does).
import { utils } from "./fallback/utils";
// Resolved by the runtime: never sent to the `fallback` plugin.
import { native } from "./fallback/native.mjs";

export default { fetch: () => Response.json([utils, native]) };
