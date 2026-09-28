// Excluded from transforms: loaded by the runtime's native TypeScript support.
// If it were transformed, the `greeting.mjs` transformer would turn this into "hi".
declare const __GREETING__: string;
module.exports = { value: typeof __GREETING__ === "undefined" ? "vendor" : __GREETING__ };
