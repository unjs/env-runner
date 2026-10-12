import type { WranglerExport } from "./wrangler.ts";
import { isPlainObject } from "./wrangler.ts";
import { workerExportsRuntime } from "./exports-runtime.ts";

/** Base class of a Worker export that workerd instantiates. */
export type WorkerExportType = "DurableObject" | "WorkerEntrypoint" | "WorkflowEntrypoint";

const WRANGLER_EXPORT_TYPES: Record<string, WorkerExportType> = {
  "durable-object": "DurableObject",
  worker: "WorkerEntrypoint",
  workflow: "WorkflowEntrypoint",
};

const EXPORT_TYPES = new Set<string>(Object.values(WRANGLER_EXPORT_TYPES));

/** Whether `type` is a Worker export type (of the runner's `exports` or an `extends` clause). */
export function isWorkerExportType(type: unknown): type is WorkerExportType {
  return typeof type === "string" && EXPORT_TYPES.has(type);
}

/**
 * Worker exports declared by the config, by class name: local Durable Object
 * and Workflow bindings of the Miniflare options, the wrangler config's
 * `exports`, then entries of the runner's `exports` record (later wins; an
 * untyped entry is a Durable Object). The wrapper exports a lazy stub for
 * each, resolved from the entry on use.
 */
export function declaredWorkerExports(opts: {
  options: Record<string, unknown>;
  wranglerExports?: Record<string, WranglerExport>;
  explicit?: Record<string, { type?: string }>;
}): Record<string, WorkerExportType> {
  const { options } = opts;
  const out: Record<string, WorkerExportType> = {};
  const durableObjects = [
    ...(isPlainObject(options.durableObjects) ? Object.values(options.durableObjects) : []),
    ...(Array.isArray(options.additionalUnboundDurableObjects)
      ? options.additionalUnboundDurableObjects
      : []),
  ];
  for (const binding of durableObjects) {
    const name = localClassName(binding);
    if (name) out[name] = "DurableObject";
  }
  for (const binding of isPlainObject(options.workflows) ? Object.values(options.workflows) : []) {
    const name = typeof binding === "string" ? undefined : localClassName(binding);
    if (name) out[name] = "WorkflowEntrypoint";
  }
  for (const name of isPlainObject(options.workflowExports)
    ? Object.keys(options.workflowExports)
    : []) {
    out[name] = "WorkflowEntrypoint";
  }
  for (const [name, entry] of Object.entries(opts.wranglerExports || {})) {
    const type = entry?.type && WRANGLER_EXPORT_TYPES[entry.type];
    if (type && (type !== "DurableObject" || isLiveDurableObject(entry))) {
      out[name] = type;
    }
  }
  for (const [name, info] of Object.entries(opts.explicit || {})) {
    out[name] = isWorkerExportType(info?.type) ? info.type : "DurableObject";
  }
  return out;
}

/** Class name of a Durable Object or Workflow binding to this Worker. */
export function localClassName(binding: unknown): string | undefined {
  return typeof binding === "string"
    ? binding
    : isPlainObject(binding) && !binding.scriptName && typeof binding.className === "string"
      ? binding.className
      : undefined;
}

/**
 * Wrapper code exporting a stub class per export, resolving the entry's class
 * on use (see `workerExportsRuntime()`). Expects the wrapper's
 * `__ensureEntry()`, `__entryExports()` and `__userEnv()`, and defines
 * `__checkExports()` and `__exportTypes()`. `configured`: the names the config
 * declares (default: all).
 */
export function generateExportStubs(
  declared: Record<string, WorkerExportType>,
  configured: string[] = Object.keys(declared),
): string {
  // Export names can be any string, and must not shadow the wrapper's globals.
  const stubs = Object.keys(declared)
    .map(
      (name, i) =>
        `const __stub${i} = __workerExports.stubs[${JSON.stringify(name)}];\nexport { __stub${i} as ${JSON.stringify(name)} };`,
    )
    .join("\n");
  return /* js */ `import {
  DurableObject as __DurableObject,
  WorkerEntrypoint as __WorkerEntrypoint,
  WorkflowEntrypoint as __WorkflowEntrypoint,
} from "cloudflare:workers";

const __workerExports = (${workerExportsRuntime.toString()})(
  {
    DurableObject: __DurableObject,
    WorkerEntrypoint: __WorkerEntrypoint,
    WorkflowEntrypoint: __WorkflowEntrypoint,
  },
  ${JSON.stringify(declared)},
  { ensureEntry: __ensureEntry, entryExports: __entryExports, userEnv: __userEnv },
  ${JSON.stringify(configured)},
);
const __checkExports = __workerExports.checkExports;
const __exportTypes = __workerExports.exportTypes;
${stubs}
`;
}

// Durable Objects deleted or transferred away (`state`) are no longer exported.
function isLiveDurableObject(entry: WranglerExport): boolean {
  return (
    entry.state === undefined || entry.state === "created" || entry.state === "expecting-transfer"
  );
}
