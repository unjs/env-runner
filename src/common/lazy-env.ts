type EnvRecord = Record<string, string | undefined>;

export function createLazyEnvProxy(
  overrides: EnvRecord = {},
): NodeJS.ProcessEnv {
  const envProxy = new Proxy(Object.create(null) as EnvRecord, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      if (prop in overrides) {
        return overrides[prop];
      }
      return process.env[prop];
    },
    has(_target, prop) {
      if (typeof prop !== "string") {
        return false;
      }
      return prop in overrides || prop in process.env;
    },
    ownKeys() {
      return Array.from(
        new Set([
          ...Reflect.ownKeys(process.env),
          ...Reflect.ownKeys(overrides),
        ]),
      );
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      if (!(prop in overrides) && !(prop in process.env)) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value: prop in overrides ? overrides[prop] : process.env[prop],
        writable: true,
      };
    },
    set(_target, prop, value) {
      if (typeof prop !== "string") {
        return false;
      }
      overrides[prop] = value as string | undefined;
      return true;
    },
    deleteProperty(_target, prop) {
      if (typeof prop !== "string") {
        return false;
      }
      delete overrides[prop];
      return true;
    },
  });

  return envProxy as NodeJS.ProcessEnv;
}
