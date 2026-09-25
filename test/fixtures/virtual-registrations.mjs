// Asserts that registerVirtualModules() registrations stack: the latest wins,
// each stays invalidatable, and unregistering one uncovers the older. Run as a
// subprocess (node or bun), like virtual-unregister.mjs.
import {
  registerVirtualModules,
  invalidateVirtualModule,
  refreshVirtualModule,
} from "../../src/common/virtual-modules.ts";

const isBun = Boolean(globalThis.Bun);

function expectValue(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// A fresh module identity for an already imported specifier: Bun matches
// extensionless (`build.module()`) keys verbatim, so re-register instead of `?query`.
async function importFresh(specifier, query) {
  if (isBun && !specifier.includes(".")) {
    if (!refreshVirtualModule(specifier)) {
      throw new Error(`refreshVirtualModule("${specifier}") did not match`);
    }
    return import(specifier);
  }
  return import(`${specifier}?${query}`);
}

const older = await registerVirtualModules({
  "#stack.mjs": `export default "older";`,
  "#stack": `export default "older";`,
  "#older-only.mjs": `export default "older only";`,
});
const newer = await registerVirtualModules({
  "#stack.mjs": `export default "newer";`,
  "#stack": `export default "newer";`,
});

expectValue((await import("#stack.mjs")).default, "newer");
expectValue((await import("#stack")).default, "newer");
expectValue((await import("#older-only.mjs")).default, "older only");

// Invalidation reaches the (older) registration that owns the key.
invalidateVirtualModule("#older-only.mjs", `export default "older only v2";`);
expectValue((await import("#older-only.mjs")).default, "older only v2");

newer();
expectValue((await importFresh("#stack.mjs", "after=1")).default, "older");
expectValue((await importFresh("#stack", "after=1")).default, "older");
older();

console.log("ok");
