/**
 * Vercel Queues local development bridge.
 *
 * Frameworks running inside the vercel runner call
 * {@link registerVercelQueueConsumer} from a startup plugin to bind a topic
 * to a handler. The first call lazy-loads `@vercel/queue` and constructs a
 * shared `QueueClient`; subsequent calls reuse it.
 *
 * If `@vercel/queue` is not installed (or is too old to expose
 * `registerDevConsumer`), a one-time warning is logged and registrations
 * become no-ops — dev startup is never blocked.
 *
 * Re-registering with the same topic replaces the previous handler (HMR-safe);
 * the unregister function is a no-op once the slot has been replaced.
 */

export interface VercelQueueDevConsumer {
  /** Topic name. Wildcard patterns (e.g. `"user-*"`) are supported. */
  topic: string;
  /**
   * Default delay used for local re-delivery when the handler throws and does
   * not return its own retry directive. Mirrors production semantics.
   */
  retryAfterSeconds?: number;
  /** Function invoked with each delivered message. */
  handler: VercelQueueDevHandler;
}

export type VercelQueueDevHandler = (message: unknown, metadata: unknown) => void | Promise<void>;

interface RegisteredSlot {
  handler: VercelQueueDevHandler;
  unregister: () => void;
}

const slots = new Map<string, RegisteredSlot>();
let sdkPromise: Promise<VercelQueueSdk | null> | undefined;
let client: unknown;

/**
 * Bind a handler to a topic. Returns an unregister function.
 *
 * The first call across the worker process lazily loads `@vercel/queue`
 * and constructs a shared `QueueClient`. Re-registering with the same topic
 * replaces the handler (HMR-safe).
 */
export function registerVercelQueueConsumer(consumer: VercelQueueDevConsumer): () => void {
  const { topic, retryAfterSeconds, handler } = consumer;

  // Replace path: a slot for this topic already exists; just swap the handler
  // so that the SDK-side closure transparently dispatches to the new one.
  const existing = slots.get(topic);
  if (existing) {
    existing.handler = handler;
    return () => {
      const slot = slots.get(topic);
      if (slot && slot.handler === handler) {
        slot.unregister();
        slots.delete(topic);
      }
    };
  }

  // First registration for this topic — kick off SDK load (idempotent) and
  // call into `@vercel/queue` once it's resolved.
  const slot: RegisteredSlot = {
    handler,
    unregister: () => {},
  };
  slots.set(topic, slot);

  ensureSdk()
    .then((resolved) => {
      if (!resolved || slots.get(topic) !== slot) return;
      slot.unregister = resolved.registerDevConsumer!({
        topic,
        client,
        consumerGroup: "env-runner-vercel-dev",
        retry: retryAfterSeconds ? () => ({ afterSeconds: retryAfterSeconds }) : undefined,
        handler: (message, metadata) => slot.handler(message, metadata),
      });
    })
    .catch((error) => {
      // `ensureSdk` handles its own load failures; anything reaching here is
      // an unexpected throw from `registerDevConsumer` itself.
      console.error(
        `[env-runner:vercel-queue] Failed to register dev consumer for "${topic}":`,
        error,
      );
    });

  return () => {
    // Check handler identity, not just slot identity. Re-registration during
    // HMR mutates `slot.handler` in place (see replace path above); if the
    // older registration's unregister fires after that mutation, we must not
    // tear down the SDK consumer that the newer registration is now using.
    if (slots.get(topic) === slot && slot.handler === handler) {
      slot.unregister();
      slots.delete(topic);
    }
  };
}

function ensureSdk(): Promise<VercelQueueSdk | null> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    let mod: VercelQueueSdk;
    try {
      mod = (await import("@vercel/queue")) as unknown as VercelQueueSdk;
    } catch {
      console.warn(
        "[env-runner:vercel-queue] `@vercel/queue` is not installed. Local queue delivery is disabled.",
      );
      return null;
    }
    if (typeof mod.registerDevConsumer !== "function") {
      console.warn(
        "[env-runner:vercel-queue] Installed `@vercel/queue` does not export `registerDevConsumer`. Upgrade @vercel/queue@^0.2.0 to enable local queue delivery.",
      );
      return null;
    }
    client = new mod.QueueClient();
    return mod;
  })();
  return sdkPromise;
}

interface VercelQueueSdk {
  QueueClient: new () => unknown;
  registerDevConsumer?: (options: {
    topic: string;
    client: unknown;
    consumerGroup?: string;
    visibilityTimeoutSeconds?: number;
    retry?: (
      error: unknown,
      metadata: unknown,
    ) => { afterSeconds: number } | { acknowledge: true } | void;
    handler: (message: unknown, metadata: unknown) => void | Promise<void>;
  }) => () => void;
}
