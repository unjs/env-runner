import { count } from "./deep.mjs";

globalThis.__evaluations ??= {};
globalThis.__evaluations.lib = (globalThis.__evaluations.lib ?? 0) + 1;

export { count };
