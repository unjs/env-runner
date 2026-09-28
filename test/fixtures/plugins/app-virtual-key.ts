// @ts-nocheck -- resolved by a plugin to a virtual path key (Bun only asks
// plugins about bare specifiers with an extension)
import value from "#virtual-key/value.mjs";

export default { fetch: () => new Response(value) };
