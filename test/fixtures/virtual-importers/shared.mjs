// Imported by both an invalidated chain (`./deep.mjs`) and `./unrelated.mjs`:
// it imports no virtual module, so it must stay a single instance.
globalThis.__evaluations ??= {};
globalThis.__evaluations.shared = (globalThis.__evaluations.shared ?? 0) + 1;
