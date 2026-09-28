// Left out by the greeting plugins' `id` filters (see `greeting-exclude.mjs`/`greeting-include.mjs`).
// If they ran on it, this would become "hi".
declare const __GREETING__: string;
module.exports = { value: typeof __GREETING__ === "undefined" ? "vendor" : __GREETING__ };
