// Kept out of the greeting plugin by `id` filters in the tests: if it ran on
// this module, `value` would become "hi".
declare const __GREETING__: string;
export const value = typeof __GREETING__ === "undefined" ? "vendor" : __GREETING__;
