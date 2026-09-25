import "./shared.mjs";

globalThis.__evaluations ??= {};
globalThis.__evaluations.unrelated = (globalThis.__evaluations.unrelated ?? 0) + 1;
