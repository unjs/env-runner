const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");
(globalThis as any)[SYMBOL_FOR_REQ_CONTEXT] = { get: () => ({}) };

await import("../node-worker/worker.ts");
