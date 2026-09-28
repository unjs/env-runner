// @ts-nocheck -- `__GREETING__` is replaced by a code-only plugin
// Only erasable types: the runtime strips them after the plugin ran.
const greeting: string = __GREETING__;

export default {
  fetch: (): Response => new Response(greeting),
};
