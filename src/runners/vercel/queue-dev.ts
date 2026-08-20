import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";

/**
 * Vercel Queues local development bridge.
 *
 * Frameworks running inside the vercel runner call
 * {@link registerVercelQueueConsumer} from a startup plugin to bind a topic
 * to a handler, preferably passing the `@vercel/queue` package they imported
 * themselves (`sdk`); without it, the SDK is imported optionally.
 * `env-runner` does not depend on `@vercel/queue`. A shared `QueueClient` is
 * constructed once per SDK instance and reused.
 *
 * If no SDK is available, or it is too old to expose `registerDevConsumer`, a
 * one-time warning is logged and registrations become no-ops — dev startup is
 * never blocked.
 *
 * Re-registering with the same topic replaces the previous handler (HMR-safe
 * via `@vercel/queue`'s own `consumerGroup` semantics).
 */

const DEFAULT_CONSUMER_GROUP = "env-runner-vercel-dev";

/** Metadata passed alongside each delivered message (`MessageMetadata`). */
export interface VercelQueueMessageMetadata {
  messageId: string;
  deliveryCount: number;
  createdAt: Date;
  expiresAt: Date;
  topicName: string;
  consumerGroup: string;
  /** Vercel region the client is targeting. */
  region: string;
}

/** Instruction returned by a retry handler when the message handler throws. */
export type VercelQueueRetryDirective = { afterSeconds: number } | { acknowledge: true };

/** Function invoked with each delivered message (`MessageHandler`). */
export type VercelQueueMessageHandler<T = unknown> = (
  message: T,
  metadata: VercelQueueMessageMetadata,
) => Promise<void> | void;

/** Called when the message handler throws (`RetryHandler`). */
export type VercelQueueRetryHandler = (
  error: unknown,
  metadata: VercelQueueMessageMetadata,
) => VercelQueueRetryDirective | void | undefined;

/**
 * The `@vercel/queue` package, as imported by the consumer
 * (`import * as queue from "@vercel/queue"`). Structurally typed so the real
 * module namespace is assignable without env-runner depending on the package.
 */
export interface VercelQueueSdk {
  QueueClient: new (options?: any) => any;
  registerDevConsumer?: (options: {
    topic: string;
    client: any;
    handler: VercelQueueMessageHandler;
    consumerGroup?: string;
    visibilityTimeoutSeconds?: number;
    retry?: VercelQueueRetryHandler;
  }) => () => void;
  [key: string]: unknown;
}

export interface VercelQueueDevConsumer {
  /**
   * The `@vercel/queue` package: the imported module, or a specifier for it.
   *
   * ```ts
   * import * as sdk from "@vercel/queue";
   * await registerVercelQueueConsumer({ sdk, topic: "orders", handler });
   *
   * // or, equivalently
   * await registerVercelQueueConsumer({ sdk: "@vercel/queue", topic, handler });
   * ```
   *
   * Passing it explicitly is preferred (`@vercel/queue` is not a dependency of
   * `env-runner`). Bare specifiers resolve from the current working directory.
   * When omitted, `@vercel/queue` is imported optionally and registration
   * becomes a no-op if the package isn't installed.
   */
  sdk?: RuntimeDep<VercelQueueSdk>;
  /** Topic name. Wildcard patterns (e.g. `"user-*"`) are supported. */
  topic: string;
  /** Function invoked with each delivered message. */
  handler: VercelQueueMessageHandler;
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
  retry?: VercelQueueRetryHandler;
}

// One shared QueueClient per SDK instance, plus a one-time warning per SDK
// that cannot serve dev consumers.
const _clients = new WeakMap<VercelQueueSdk, any>();
const _warned = new WeakSet<VercelQueueSdk>();
let _warnedMissing = false;
let _importedSdk: Promise<VercelQueueSdk | undefined> | undefined;

const noop = () => {};

/**
 * Bind a handler to a topic. Resolves to an unregister function.
 *
 * A shared `QueueClient` is constructed from `sdk` on first use and reused for
 * later registrations with the same SDK. Re-registering with the same topic
 * replaces the handler (HMR-safe; the SDK keys consumers by `consumerGroup`,
 * so calling unregister on a replaced registration is a no-op).
 *
 * If no SDK is available, or it does not expose `registerDevConsumer`,
 * resolves to a no-op unregister and logs a one-time warning.
 */
export async function registerVercelQueueConsumer(
  consumer: VercelQueueDevConsumer,
): Promise<() => void> {
  const sdk = await resolveSdk(consumer.sdk);
  if (!sdk) {
    if (!_warnedMissing) {
      _warnedMissing = true;
      console.warn(
        "[env-runner:vercel-queue] `@vercel/queue` is not installed and no `sdk` was passed. Local queue delivery is disabled.",
      );
    }
    return noop;
  }
  if (typeof sdk.registerDevConsumer !== "function") {
    if (!_warned.has(sdk)) {
      _warned.add(sdk);
      console.warn(
        "[env-runner:vercel-queue] The `@vercel/queue` SDK in use does not export `registerDevConsumer`. Upgrade @vercel/queue@^0.2.0 to enable local queue delivery.",
      );
    }
    return noop;
  }

  let client = _clients.get(sdk);
  if (!client) {
    client = new sdk.QueueClient();
    _clients.set(sdk, client);
  }

  return sdk.registerDevConsumer({
    topic: consumer.topic,
    client,
    handler: consumer.handler,
    consumerGroup: consumer.consumerGroup ?? DEFAULT_CONSUMER_GROUP,
    visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds,
    retry:
      consumer.retry ??
      (consumer.retryAfterSeconds === undefined
        ? undefined
        : () => ({ afterSeconds: consumer.retryAfterSeconds! })),
  });
}

/**
 * Resolve the `sdk` option (imported module, specifier, or `false`) to a
 * module. The optional fallback import is memoized — it runs once per process
 * however many consumers register.
 */
function resolveSdk(value: RuntimeDep<VercelQueueSdk> | undefined) {
  if (value !== undefined) {
    return resolveRuntimeDep<VercelQueueSdk>({
      name: "@vercel/queue",
      option: "sdk",
      value,
    });
  }
  _importedSdk ??= resolveRuntimeDep<VercelQueueSdk>({
    name: "@vercel/queue",
    option: "sdk",
  });
  return _importedSdk;
}
