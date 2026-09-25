export const DEFAULT_RETRY_BACKOFF_MS = 1000;

/**
 * The pause before a transient failure is requeued. Same variable and default
 * as the Catalog, so both services settle alike when a dependency is down.
 */
export function retryBackoffMs(): number {
  // SPEC_DEVIATION: the Catalog's copy reads a blank value as 0 ms.
  // Reason: a blank variable is how compose files spell "unset", and 0 ms is
  // the immediate requeue RM-20 forbids, so a blank value takes the default.
  const raw = process.env.RABBITMQ_RETRY_BACKOFF_MS;
  // A blank value is unset, not zero: `Number('')` is 0, and no pause at all
  // is exactly the spin this setting exists to prevent.
  const configured = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_RETRY_BACKOFF_MS;
}

/**
 * The message itself is wrong. `ValidationRejectedError` and
 * `ProcessingRejectedError` extend it, so this module classifies both without
 * importing the consumers that throw them.
 */
// SPEC_DEVIATION: design.md lists ValidationRejectedError and
// ProcessingRejectedError by name. Reason: both extend this class instead, so
// classifying them does not import the consumers that import this module.
export class MessageRejectedError extends Error {}

/**
 * A failure no retry can fix: the message itself is wrong. A required field
 * it lacks, or a body that is not JSON, fails identically on every delivery.
 */
export function isPermanentFailure(error: unknown): boolean {
  return error instanceof MessageRejectedError || error instanceof SyntaxError;
}

interface NackingChannel {
  nack(message: unknown, allUpTo?: boolean, requeue?: boolean): void;
}

/**
 * Settles a message whose handling threw (RM-20, AD-012).
 *
 * Permanent failures are rejected without requeue, which the broker's
 * dead-letter policy routes to `<queue>.dlq`.
 *
 * Anything else is presumed transient - storage or the broker briefly away -
 * and requeued, but only after a pause. RabbitMQ 4 does not count an explicit
 * requeue against a quorum queue's delivery limit, so the limit cannot bound
 * this loop; the pause is what keeps it from spinning while the dependency is
 * down. Retrying indefinitely is deliberate: a transient outage must not
 * dead-letter every message that happened to be in flight.
 *
 * Mirrors `processing-catalog/src/infrastructure/rabbitmq/settle-failed-message.ts`.
 */
export async function settleFailedMessage(
  channel: NackingChannel,
  message: unknown,
  error: unknown,
  backoffMs: number = retryBackoffMs(),
): Promise<void> {
  if (isPermanentFailure(error)) {
    channel.nack(message, false, false);
    return;
  }
  if (backoffMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  channel.nack(message, false, true);
}
