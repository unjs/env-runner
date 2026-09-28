// @ts-nocheck -- `.wasm` loaded by a plugin
import { add } from "./add.wasm";

export default { fetch: () => new Response(String(add(2, 3))) };
