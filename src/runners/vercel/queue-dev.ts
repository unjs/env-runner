import { resolveRuntimeDep } from "../../common/runtime-deps.ts";
import type { RuntimeDep } from "../../common/runtime-deps.ts";

/** Vercel Queues dev bridge: frameworks call {@link registerVercelQueueConsumer} from a startup plugin. */

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

/** `@vercel/queue` namespace, structurally typed to avoid depending on the package. */
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
   * The `@vercel/queue` package (`import * as sdk from "@vercel/queue"`) or a
   * specifier resolved from cwd. Omitted: imported optionally.
   */
  sdk?: RuntimeDep<VercelQueueSdk>;
  /** Topic name. Wildcard patterns (e.g. `"user-*"`) are supported. */
  topic: string;
  /** Function invoked with each delivered message. */
  handler: VercelQueueMessageHandler;
  /**
   * Same group + topic replaces the handler; distinct groups coexist.
   * @default "env-runner-vercel-dev"
   */
  consumerGroup?: string;
  /** Lock duration for in-flight messages (SDK `coreHandleCallback`). */
  visibilityTimeoutSeconds?: number;
  /** Re-delivery delay when the handler throws; shorthand for `retry` (which wins). */
  retryAfterSeconds?: number;
  /** Return `{ afterSeconds }` to reschedule, `{ acknowledge: true }` to drop, or `undefined` to rethrow. */
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
 * Bind a handler to a topic; resolves to an unregister function (a no-op once
 * replaced). Without a usable SDK, warns once and no-ops.
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

/** The optional fallback import is memoized per process. */
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
