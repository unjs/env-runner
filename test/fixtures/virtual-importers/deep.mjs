import count from "#count";
import "./shared.mjs";

globalThis.__evaluations ??= {};
globalThis.__evaluations.deep = (globalThis.__evaluations.deep ?? 0) + 1;

export { count };
