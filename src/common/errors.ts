/**
 * An error whose message ends with the cause's message (`<message>: <reason>`),
 * keeping the cause as `error.cause`. Without a cause, just `message`.
 */
export function errorWithCause(message: string, cause: unknown): Error {
  if (!cause) return new Error(message);
  const reason = _causeMessage(cause);
  return new Error(reason ? `${message}: ${reason}` : message, { cause });
}

/** `waitForReady()` rejection of a runner (or manager) closed before it was ready. */
export function closedBeforeReadyError(cause: unknown): Error {
  return errorWithCause("Runner closed before becoming ready", cause);
}

// Never throws (runs inside `close()` and timers), so non-string messages are skipped.
function _causeMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  const message = (cause as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}
