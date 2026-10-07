import type { WranglerExport } from "./wrangler.ts";
import { isPlainObject } from "./wrangler.ts";

/** Base class of a Worker export that workerd instantiates. */
export type WorkerExportType = "DurableObject" | "WorkerEntrypoint" | "WorkflowEntrypoint";

const WRANGLER_EXPORT_TYPES: Record<string, WorkerExportType> = {
  "durable-object": "DurableObject",
  worker: "WorkerEntrypoint",
  workflow: "WorkflowEntrypoint",
};

/**
 * Worker exports declared by the config, by class name: local Durable Object
 * and Workflow bindings of the Miniflare options, the wrangler config's
 * `exports`, then typed entries of the runner's `exports` record (later wins).
 * The wrapper exports a lazy stub for each, resolved from the entry on use.
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
    // Durable Objects deleted or transferred away (`state`) are no longer exported.
    const state = entry?.state;
    if (
      type &&
      (type !== "DurableObject" ||
        state === undefined ||
        state === "created" ||
        state === "expecting-transfer")
    ) {
      out[name] = type;
    }
  }
  for (const [name, info] of Object.entries(opts.explicit || {})) {
    if (
      info?.type === "DurableObject" ||
      info?.type === "WorkerEntrypoint" ||
      info?.type === "WorkflowEntrypoint"
    ) {
      out[name] = info.type;
    }
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
 * Wrapper code exporting a stub class per declared export (like
 * `@cloudflare/vite-plugin`): workerd needs the classes at startup, but the
 * entry loads dynamically, so each stub resolves the entry's class on use (and
 * again after a reload). Expects the wrapper's `__ensureEntry()`,
 * `__entryExports()` and `__userEnv()`.
 */
export function generateExportStubs(
  declared: Record<string, WorkerExportType>,
  staticExports: string[],
): string {
  // Export names can be any string, and must not shadow the wrapper's globals.
  const stubs = Object.entries(declared)
    .map(
      ([name, type], i) =>
        `const __stub${i} = __stub_${type}(${JSON.stringify(name)});\nexport { __stub${i} as ${JSON.stringify(name)} };`,
    )
    .join("\n");
  return /* js */ `import {
  DurableObject as __DurableObject,
  WorkerEntrypoint as __WorkerEntrypoint,
  WorkflowEntrypoint as __WorkflowEntrypoint,
} from "cloudflare:workers";

const __declaredExports = ${JSON.stringify(declared)};
const __staticExports = ${JSON.stringify(staticExports)};
const __DO_KEYS = ["alarm", "connect", "fetch", "webSocketClose", "webSocketError", "webSocketMessage"];
const __WE_KEYS = ["connect", "email", "fetch", "queue", "tail", "tailStream", "test", "trace", "scheduled"];
const __IGNORED_KEYS = ["self"];
const __kInstance = Symbol("instance");
const __kEnsureInstance = Symbol("ensureInstance");

function __expected(name, what) {
  return 'Expected "' + name + '" export of the entry to ' + what;
}

async function __resolveExport(env, name) {
  await __ensureEntry(env);
  const value = (await __entryExports())?.[name];
  if (value === undefined) {
    throw new TypeError(
      '"' + name + '" is declared as a ' + __declaredExports[name] + " but the entry does not export it."
    );
  }
  return value;
}

// Awaitable and callable, so RPC properties work as values and as methods.
function __rpcThenable(key, property) {
  const fn = async (...args) => {
    const maybeFn = await property;
    if (typeof maybeFn !== "function") {
      throw new TypeError('"' + key + '" is not a function.');
    }
    return maybeFn(...args);
  };
  fn.then = (onFulfilled, onRejected) => property.then(onFulfilled, onRejected);
  fn.catch = (onRejected) => property.catch(onRejected);
  fn.finally = (onFinally) => property.finally(onFinally);
  return fn;
}

// Only prototype members are exposed over RPC, as by workerd.
function __rpcProperty(ctor, instance, key) {
  if (!Reflect.has(ctor.prototype, key)) {
    if (Reflect.has(instance, key)) {
      throw new TypeError(
        'The RPC receiver\\'s prototype does not implement "' + key + '", but the receiver instance does.\\n' +
          "Only properties and methods defined on the prototype can be accessed over RPC.\\n" +
          "Ensure properties are declared as \`get " + key + "() { ... }\` instead of \`" + key + " = ...\`,\\n" +
          "and methods are declared as \`" + key + "() { ... }\` instead of \`" + key + " = () => { ... }\`."
      );
    }
    throw new TypeError('The RPC receiver does not implement "' + key + '".');
  }
  const value = Reflect.get(ctor.prototype, key, instance);
  return typeof value === "function" ? value.bind(instance) : value;
}

// workerd reads the other class kind's handler keys to tell the kinds apart.
function __rpcProxy(target, otherKeys, getProperty) {
  return new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (value !== undefined) return value;
      if (typeof key === "symbol" || __IGNORED_KEYS.includes(key) || otherKeys.includes(key)) {
        return;
      }
      return __rpcThenable(key, getProperty(receiver, key));
    },
  });
}

function __stub_DurableObject(name) {
  class Stub extends __DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      return __rpcProxy(this, __WE_KEYS, async (receiver, key) => {
        const { ctor, instance } = await receiver[__kEnsureInstance]();
        if (!(instance instanceof __DurableObject)) {
          throw new TypeError(__expected(name, "be a subclass of \`DurableObject\` for RPC."));
        }
        return __rpcProperty(ctor, instance, key);
      });
    }
    // One instance per stub, replaced when a reload changes the class.
    async [__kEnsureInstance]() {
      const ctor = await __resolveExport(this.env, name);
      if (typeof ctor !== "function") {
        throw new TypeError(__expected(name, "be a Durable Object class."));
      }
      if (!this[__kInstance] || this[__kInstance].ctor !== ctor) {
        this[__kInstance] = { ctor, instance: new ctor(this.ctx, __userEnv(this.env)) };
        // Wait for \`blockConcurrencyWhile()\` calls of the constructor.
        await this.ctx.blockConcurrencyWhile(async () => {});
      }
      return this[__kInstance];
    }
  }
  for (const key of __DO_KEYS) {
    Stub.prototype[key] = async function (...args) {
      const { instance } = await this[__kEnsureInstance]();
      if (typeof instance[key] !== "function") {
        throw new TypeError(__expected(name, "define a \`" + key + "()\` method."));
      }
      return instance[key](...args);
    };
  }
  return Stub;
}

function __stub_WorkerEntrypoint(name) {
  class Stub extends __WorkerEntrypoint {
    constructor(ctx, env) {
      super(ctx, env);
      return __rpcProxy(this, __DO_KEYS, async (receiver, key) => {
        const ctor = await __resolveExport(receiver.env, name);
        const instance =
          typeof ctor === "function" ? new ctor(receiver.ctx, __userEnv(receiver.env)) : undefined;
        if (!(instance instanceof __WorkerEntrypoint)) {
          throw new TypeError(__expected(name, "be a subclass of \`WorkerEntrypoint\` for RPC."));
        }
        return __rpcProperty(ctor, instance, key);
      });
    }
  }
  for (const key of __WE_KEYS) {
    Stub.prototype[key] = async function (arg) {
      const value = await __resolveExport(this.env, name);
      const env = __userEnv(this.env);
      // A class, or an \`ExportedHandler\` object.
      if (typeof value === "function") {
        const instance = new value(this.ctx, env);
        if (!(instance instanceof __WorkerEntrypoint)) {
          throw new TypeError(__expected(name, "be a subclass of \`WorkerEntrypoint\`."));
        }
        if (typeof instance[key] !== "function") {
          throw new TypeError(__expected(name, "define a \`" + key + "()\` method."));
        }
        return instance[key](arg);
      }
      if (value && typeof value === "object" && typeof value[key] === "function") {
        return value[key](arg, env, this.ctx);
      }
      throw new TypeError(__expected(name, "define a \`" + key + "()\` handler."));
    };
  }
  return Stub;
}

function __stub_WorkflowEntrypoint(name) {
  class Stub extends __WorkflowEntrypoint {}
  Stub.prototype.run = async function (...args) {
    const ctor = await __resolveExport(this.env, name);
    const instance = typeof ctor === "function" ? new ctor(this.ctx, __userEnv(this.env)) : undefined;
    if (!(instance instanceof __WorkflowEntrypoint)) {
      throw new TypeError(__expected(name, "be a subclass of \`WorkflowEntrypoint\`."));
    }
    return instance.run(...args);
  };
  return Stub;
}

const __exportBases = {
  DurableObject: __DurableObject,
  WorkerEntrypoint: __WorkerEntrypoint,
  WorkflowEntrypoint: __WorkflowEntrypoint,
};

const __exportHints = {
  DurableObject: (name) =>
    'add a "durable_objects" binding for it, or "exports": { "' + name + '": { "type": "durable-object" } }',
  WorkerEntrypoint: (name) => 'add "exports": { "' + name + '": { "type": "worker" } }',
  WorkflowEntrypoint: (name) => 'add a "workflows" entry with "class_name": "' + name + '"',
};

function __extendsBase(value, type) {
  return typeof value === "function" && value.prototype instanceof __exportBases[type];
}

let __exportWarnings = "";

// After each entry (re)load: declared classes the entry lacks, and exported
// classes workerd won't see because nothing declares them. Warns on change.
async function __checkExports() {
  let exports;
  try {
    exports = await __entryExports();
  } catch {
    return;
  }
  if (!exports || typeof exports !== "object") return;
  const warnings = [];
  for (const [name, type] of Object.entries(__declaredExports)) {
    const value = exports[name];
    if (value === undefined) {
      warnings.push('"' + name + '" is declared as a ' + type + " but not exported by the entry.");
    } else if (
      type === "DurableObject"
        ? typeof value !== "function"
        : type === "WorkerEntrypoint"
          ? !__extendsBase(value, type) && (typeof value !== "object" || value === null)
          : !__extendsBase(value, type)
    ) {
      warnings.push('"' + name + '" is declared as a ' + type + " but its export is not a " + type + ".");
    }
  }
  for (const name of Object.keys(exports)) {
    if (name in __declaredExports || __staticExports.includes(name)) continue;
    const type = Object.keys(__exportBases).find((type) => __extendsBase(exports[name], type));
    if (type) {
      warnings.push(
        '"' + name + '" extends ' + type + " but is not declared, so workerd can't use it: " +
          __exportHints[type](name) + " to the wrangler config."
      );
    }
  }
  const text = warnings.join("\\n");
  if (text && text !== __exportWarnings) {
    console.warn("[env-runner] Worker exports:\\n  - " + warnings.join("\\n  - "));
  }
  __exportWarnings = text;
}

${stubs}
`;
}
