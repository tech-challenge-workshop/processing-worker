import { createHash } from 'node:crypto';
import type { WorkerEventType } from './event-routes';

/**
 * The namespace every outcome id of this Worker is derived under. Fixed:
 * changing it would give every redelivered job a new id for the outcome it
 * already published.
 */
export const OUTCOME_EVENT_ID_NAMESPACE =
  '1dd42c76-48f1-4e9a-b5db-a9bff5bad025';

/** A name-based UUID, version 5 (SHA-1), as RFC 4122 section 4.3 defines it. */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespaceBytes)
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * The `eventId` of an outcome this Worker publishes (RM-18).
 *
 * Derived from the consumed event's id and the outcome type rather than drawn
 * at random, so a redelivery of the same message republishes under the same
 * id and the Catalog's `eventId` deduplication absorbs it. A new attempt
 * arrives as a new message with a new id, so it still gets new outcome ids,
 * and two outcomes of one job (`ProcessingStarted`, `ProcessingCompleted`)
 * differ by type.
 */
export function outcomeEventId(
  consumedEventId: string,
  outcome: WorkerEventType,
): string {
  return uuidV5(`${consumedEventId}:${outcome}`, OUTCOME_EVENT_ID_NAMESPACE);
}
