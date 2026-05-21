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
 * Re-registering with the same topic replaces the previous handler (HMR-safe
 * via `@vercel/queue`'s own `consumerGroup` semantics).
 */
import type { MessageHandler, QueueClient, RetryHandler } from "@vercel/queue";

const DEFAULT_CONSUMER_GROUP = "env-runner-vercel-dev";

export interface VercelQueueDevConsumer {
  /** Topic name. Wildcard patterns (e.g. `"user-*"`) are supported. */
  topic: string;
  /** Function invoked with each delivered message. */
  handler: MessageHandler;
  /**
   * Logical consumer identifier. Re-registering with the same group on the same
   * topic replaces the previous handler (HMR-safe). Use distinct groups to fan
   * a topic out to multiple coexisting handlers.
   *
   * @default "env-runner-vercel-dev"
   */
  consumerGroup?: string;
  /**
   * Lock duration for in-flight messages. Forwarded to the SDK's
   * `coreHandleCallback`.
   */
  visibilityTimeoutSeconds?: number;
  /**
   * Convenience: rescheduled re-delivery delay applied when the handler throws.
   * Equivalent to `retry: () => ({ afterSeconds })`. Ignored if `retry` is set.
   */
  retryAfterSeconds?: number;
  /**
   * Full retry handler. Receives the thrown error and message metadata; return
   * `{ afterSeconds }` to reschedule, `{ acknowledge: true }` to drop, or
   * `undefined` to let the error propagate.
   */
  retry?: RetryHandler;
}

type VercelQueueSdk = typeof import("@vercel/queue");

let sdkPromise: Promise<VercelQueueSdk | null> | undefined;
let client: QueueClient | undefined;

const noop = () => {};

/**
 * Bind a handler to a topic. Resolves to an unregister function.
 *
 * The first call across the worker process lazily loads `@vercel/queue` and
 * constructs a shared `QueueClient`. Re-registering with the same topic
 * replaces the handler (HMR-safe; the SDK keys consumers by `consumerGroup`,
 * so calling unregister on a replaced registration is a no-op).
 *
 * If `@vercel/queue` is not installed or does not expose `registerDevConsumer`,
 * resolves to a no-op unregister and logs a one-time warning.
 */
export async function registerVercelQueueConsumer(
  consumer: VercelQueueDevConsumer,
): Promise<() => void> {
  const sdk = await ensureSdk();
  if (!sdk || !client) return noop;

  const { topic, handler, consumerGroup, visibilityTimeoutSeconds, retry, retryAfterSeconds } =
    consumer;
  return sdk.registerDevConsumer({
    topic,
    client,
    handler,
    consumerGroup: consumerGroup ?? DEFAULT_CONSUMER_GROUP,
    visibilityTimeoutSeconds,
    retry:
      retry ??
      (retryAfterSeconds === undefined ? undefined : () => ({ afterSeconds: retryAfterSeconds })),
  });
}

function ensureSdk(): Promise<VercelQueueSdk | null> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    let mod: VercelQueueSdk;
    try {
      mod = await import("@vercel/queue");
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
