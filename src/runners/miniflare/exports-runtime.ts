import type { WorkerExportType } from "./exports.ts";

/** Base classes of `cloudflare:workers`, by export type. */
export type WorkerExportBases = Record<WorkerExportType, any>;

/** Wrapper functions the stubs resolve the entry's classes with. */
export interface WorkerExportsHost {
  ensureEntry(env: any): Promise<void>;
  entryExports(): Promise<Record<string, any> | undefined>;
  userEnv(env: any): any;
}

/**
 * Runs inside workerd: the wrapper inlines it with `toString()`, so it must
 * not reference anything outside its own body.
 *
 * Returns a stub class per declared export (like `@cloudflare/vite-plugin`):
 * workerd needs the classes at startup, but the entry loads dynamically, so
 * each stub resolves the entry's class on use (and again after a reload).
 */
export function workerExportsRuntime(
  bases: WorkerExportBases,
  declared: Record<string, WorkerExportType>,
  host: WorkerExportsHost,
): { stubs: Record<string, unknown>; checkExports: () => Promise<void> } {
  const DO_KEYS = [
    "alarm",
    "connect",
    "fetch",
    "webSocketClose",
    "webSocketError",
    "webSocketMessage",
  ];
  const WE_KEYS = [
    "connect",
    "email",
    "fetch",
    "queue",
    "tail",
    "tailStream",
    "test",
    "trace",
    "scheduled",
  ];
  const IGNORED_KEYS = ["self"];
  const kInstance = Symbol("instance");
  const kEnsureInstance = Symbol("ensureInstance");

  const hints: Record<WorkerExportType, (name: string) => string> = {
    DurableObject: (name) =>
      `add a "durable_objects" binding for it, or "exports": { "${name}": { "type": "durable-object" } }`,
    WorkerEntrypoint: (name) => `add "exports": { "${name}": { "type": "worker" } }`,
    WorkflowEntrypoint: (name) => `add a "workflows" entry with "class_name": "${name}"`,
  };

  function expected(name: string, what: string) {
    return `Expected "${name}" export of the entry to ${what}`;
  }

  function extendsBase(value: any, type: WorkerExportType) {
    return typeof value === "function" && value.prototype instanceof bases[type];
  }

  // A Durable Object can be any class, a `WorkerEntrypoint` also an `ExportedHandler` object.
  function isExportOfType(value: any, type: WorkerExportType) {
    if (type === "DurableObject") return typeof value === "function";
    if (type === "WorkerEntrypoint" && typeof value === "object" && value !== null) return true;
    return extendsBase(value, type);
  }

  async function resolveExport(env: any, name: string) {
    await host.ensureEntry(env);
    const value = (await host.entryExports())?.[name];
    if (value === undefined) {
      throw new TypeError(
        `"${name}" is declared as a ${declared[name]} but the entry does not export it.`,
      );
    }
    return value;
  }

  // A new instance of the entry's class, for one call of a `WorkerEntrypoint` or Workflow.
  function construct(stub: any, ctor: any, name: string, type: WorkerExportType, what = "") {
    const instance =
      typeof ctor === "function" ? new ctor(stub.ctx, host.userEnv(stub.env)) : undefined;
    if (!(instance instanceof bases[type])) {
      throw new TypeError(expected(name, `be a subclass of \`${type}\`${what}.`));
    }
    return instance;
  }

  function method(instance: any, name: string, key: string) {
    if (typeof instance[key] !== "function") {
      throw new TypeError(expected(name, `define a \`${key}()\` method.`));
    }
    return instance[key].bind(instance);
  }

  // Awaitable and callable, so RPC properties work as values and as methods.
  function rpcThenable(key: string, property: Promise<any>) {
    const fn: any = async (...args: unknown[]) => {
      const maybeFn = await property;
      if (typeof maybeFn !== "function") {
        throw new TypeError(`"${key}" is not a function.`);
      }
      return maybeFn(...args);
    };
    // oxlint-disable-next-line unicorn/no-thenable
    fn.then = (onFulfilled: any, onRejected: any) => property.then(onFulfilled, onRejected);
    fn.catch = (onRejected: any) => property.catch(onRejected);
    fn.finally = (onFinally: any) => property.finally(onFinally);
    return fn;
  }

  // Only prototype members are exposed over RPC, as by workerd.
  function rpcProperty(ctor: any, instance: any, key: string) {
    if (!Reflect.has(ctor.prototype, key)) {
      if (Reflect.has(instance, key)) {
        throw new TypeError(
          `The RPC receiver's prototype does not implement "${key}", but the receiver instance does.\n` +
            "Only properties and methods defined on the prototype can be accessed over RPC.\n" +
            `Ensure properties are declared as \`get ${key}() { ... }\` instead of \`${key} = ...\`,\n` +
            `and methods are declared as \`${key}() { ... }\` instead of \`${key} = () => { ... }\`.`,
        );
      }
      throw new TypeError(`The RPC receiver does not implement "${key}".`);
    }
    const value = Reflect.get(ctor.prototype, key, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  }

  // workerd reads the other class kind's handler keys to tell the kinds apart.
  function rpcProxy(
    target: any,
    otherKeys: string[],
    getProperty: (receiver: any, key: string) => Promise<any>,
  ) {
    return new Proxy(target, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (value !== undefined) return value;
        if (typeof key === "symbol" || IGNORED_KEYS.includes(key) || otherKeys.includes(key)) {
          return;
        }
        return rpcThenable(key, getProperty(receiver, key));
      },
    });
  }

  function durableObjectStub(name: string) {
    class Stub extends bases.DurableObject {
      constructor(ctx: any, env: any) {
        super(ctx, env);
        return rpcProxy(this, WE_KEYS, async (receiver, key) => {
          const { ctor, instance } = await receiver[kEnsureInstance]();
          if (!(instance instanceof bases.DurableObject)) {
            throw new TypeError(expected(name, "be a subclass of `DurableObject` for RPC."));
          }
          return rpcProperty(ctor, instance, key);
        });
      }
      // One instance per stub, replaced when a reload changes the class.
      async [kEnsureInstance]() {
        const ctor = await resolveExport(this.env, name);
        if (typeof ctor !== "function") {
          throw new TypeError(expected(name, "be a Durable Object class."));
        }
        const self = this as any;
        if (!self[kInstance] || self[kInstance].ctor !== ctor) {
          self[kInstance] = { ctor, instance: new ctor(this.ctx, host.userEnv(this.env)) };
          // Wait for `blockConcurrencyWhile()` calls of the constructor.
          await this.ctx.blockConcurrencyWhile(async () => {});
        }
        return self[kInstance];
      }
    }
    for (const key of DO_KEYS) {
      (Stub.prototype as any)[key] = async function (this: Stub, ...args: unknown[]) {
        const { instance } = await this[kEnsureInstance]();
        return method(instance, name, key)(...args);
      };
    }
    return Stub;
  }

  function workerEntrypointStub(name: string) {
    class Stub extends bases.WorkerEntrypoint {
      constructor(ctx: any, env: any) {
        super(ctx, env);
        return rpcProxy(this, DO_KEYS, async (receiver, key) => {
          const ctor = await resolveExport(receiver.env, name);
          const instance = construct(receiver, ctor, name, "WorkerEntrypoint", " for RPC");
          return rpcProperty(ctor, instance, key);
        });
      }
    }
    for (const key of WE_KEYS) {
      (Stub.prototype as any)[key] = async function (this: any, arg: unknown) {
        const value = await resolveExport(this.env, name);
        // A class, or an `ExportedHandler` object.
        if (typeof value === "function") {
          return method(construct(this, value, name, "WorkerEntrypoint"), name, key)(arg);
        }
        if (typeof value?.[key] !== "function") {
          throw new TypeError(expected(name, `define a \`${key}()\` handler.`));
        }
        return value[key](arg, host.userEnv(this.env), this.ctx);
      };
    }
    return Stub;
  }

  function workflowEntrypointStub(name: string) {
    class Stub extends bases.WorkflowEntrypoint {
      async run(...args: unknown[]) {
        const ctor = await resolveExport(this.env, name);
        return construct(this, ctor, name, "WorkflowEntrypoint").run(...args);
      }
    }
    return Stub;
  }

  const createStub = {
    DurableObject: durableObjectStub,
    WorkerEntrypoint: workerEntrypointStub,
    WorkflowEntrypoint: workflowEntrypointStub,
  };
  const stubs: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(declared)) {
    stubs[name] = createStub[type](name);
  }

  let lastWarnings = "";

  // After each entry (re)load: declared classes the entry lacks, and exported
  // classes workerd won't see because nothing declares them. Warns on change.
  async function checkExports() {
    let exports;
    try {
      exports = await host.entryExports();
    } catch {
      return;
    }
    if (!exports || typeof exports !== "object") return;
    const warnings: string[] = [];
    for (const [name, type] of Object.entries(declared)) {
      const value = exports[name];
      if (value === undefined) {
        warnings.push(`"${name}" is declared as a ${type} but not exported by the entry.`);
      } else if (!isExportOfType(value, type)) {
        warnings.push(`"${name}" is declared as a ${type} but its export is not a ${type}.`);
      }
    }
    for (const name of Object.keys(exports)) {
      if (name in declared) continue;
      const type = (Object.keys(bases) as WorkerExportType[]).find((type) =>
        extendsBase(exports[name], type),
      );
      if (type) {
        warnings.push(
          `"${name}" extends ${type} but is not declared, so workerd can't use it: ${hints[type](name)} to the wrangler config.`,
        );
      }
    }
    const text = warnings.join("\n");
    if (text && text !== lastWarnings) {
      console.warn("[env-runner] Worker exports:\n  - " + warnings.join("\n  - "));
    }
    lastWarnings = text;
  }

  return { stubs, checkExports };
}
