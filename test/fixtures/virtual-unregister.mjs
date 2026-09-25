// Asserts that the unregister function returned by registerVirtualModules()
// releases the registration. Run as a subprocess (node or bun) because the
// vitest module runner intercepts dynamic imports, bypassing the ESM hooks.
import { registerVirtualModules, refreshVirtualModule } from "../../src/common/virtual-modules.ts";

const unregister = await registerVirtualModules({
  "#unregister-test": `export const value = "registered";`,
});

const mod = await import("#unregister-test");
if (mod.value !== "registered") {
  throw new Error("virtual import did not resolve before unregister");
}

const isBun = Boolean(globalThis.Bun);
if (isBun && !refreshVirtualModule("#unregister-test")) {
  throw new Error("refreshVirtualModule did not match before unregister");
}

unregister();
unregister(); // must be idempotent

if (isBun) {
  // Bun's plugin API has no removal; unregister detaches the live source map,
  // which is what stops reloads (refreshVirtualModule) and fresh loads.
  if (refreshVirtualModule("#unregister-test")) {
    throw new Error("refreshVirtualModule still matches after unregister");
  }
} else {
  // registerHooks backend: deregistered hooks no longer resolve the specifier
  // (the query suffix skips the cached module from the import above).
  let failed = false;
  try {
    await import("#unregister-test?fresh=1");
  } catch {
    failed = true;
  }
  if (!failed) {
    throw new Error("virtual import still resolves after unregister");
  }
}

// A path key overriding a real file: after unregistering, the file loads from
// disk again (Bun: its `onLoad` filter stays installed but can't decline).
const { fileURLToPath, pathToFileURL } = await import("node:url");
const config = fileURLToPath(new URL("virtual-paths/config.mjs", import.meta.url));
// Bun drops a query from `file:` URLs, but keeps it on paths.
const importPath = (query) => (isBun ? config : pathToFileURL(config).href) + query;
const unregisterPath = await registerVirtualModules({ [config]: `export default "virtual";` });
if ((await import(importPath("?path=1"))).default !== "virtual") {
  throw new Error("path key did not override the real file before unregister");
}
unregisterPath();
if ((await import(importPath("?path=2"))).default !== "disk config") {
  throw new Error("real file did not load from disk after unregister");
}

console.log("ok");
