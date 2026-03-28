// Provides the request context that @vercel/functions reads from
// https://github.com/vercel/vercel/blob/main/packages/functions/src/get-context.ts
const SYMBOL_FOR_REQ_CONTEXT = Symbol.for("@vercel/request-context");

const waitUntilPromises = new Set<Promise<unknown>>();

type CacheEntry = {
  value: string;
  lastModified: number;
  ttl?: number;
  tags: Set<string>;
};

const cacheStore = new Map<string, CacheEntry>();
const cacheTags = new Set<string>();

(globalThis as any)[SYMBOL_FOR_REQ_CONTEXT] = {
  get: () => ({
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.add(promise);
      promise.finally(() => waitUntilPromises.delete(promise));
    },
    cache: {
      async get(key: string) {
        const entry = cacheStore.get(key);
        if (!entry) return null;
        if (entry.ttl && entry.lastModified + entry.ttl * 1000 < Date.now()) {
          cacheStore.delete(key);
          return null;
        }
        return JSON.parse(entry.value);
      },
      async set(
        key: string,
        value: unknown,
        options?: { name?: string; tags?: string[]; ttl?: number },
      ) {
        cacheStore.set(key, {
          value: JSON.stringify(value ?? null),
          lastModified: Date.now(),
          ttl: options?.ttl,
          tags: new Set(options?.tags || []),
        });
      },
      async delete(key: string) {
        cacheStore.delete(key);
      },
      async expireTag(tag: string | string[]) {
        const tags = Array.isArray(tag) ? tag : [tag];
        for (const [key, entry] of cacheStore) {
          if (tags.some((t) => entry.tags.has(t))) {
            cacheStore.delete(key);
          }
        }
      },
    },
    purge: {
      invalidateByTag: (_tag: string | string[]) => Promise.resolve(),
      dangerouslyDeleteByTag: (_tag: string | string[]) => Promise.resolve(),
      invalidateBySrcImage: (_src: string | string[]) => Promise.resolve(),
      dangerouslyDeleteBySrcImage: (_src: string | string[]) => Promise.resolve(),
    },
    addCacheTag(tag: string | string[]) {
      for (const t of Array.isArray(tag) ? tag : [tag]) {
        cacheTags.add(t);
      }
      return Promise.resolve();
    },
  }),
};

await import("../node-worker/worker.ts");
