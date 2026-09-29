import { randomUUID } from 'node:crypto';
import {
  correlationContext,
  parseCorrelationId,
} from '../observability/correlation-context';

/**
 * Runs a consumer's handling inside the consumed message's correlation scope
 * (OBS-31), so every log line and every outcome event it emits carries that
 * id. `payload` is what `@Payload()` hands the handler: Nest has already
 * unwrapped the `{pattern, data}` envelope. A missing or invalid id is
 * replaced by a fresh one and never fails the message (OBS-34); a non-string
 * is never coerced (L-010). The scope ends when `handle` settles, whether it
 * resolves or throws.
 */
export function withMessageCorrelation<T>(
  payload: unknown,
  handle: () => Promise<T>,
): Promise<T> {
  const raw =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).correlationId
      : undefined;
  const id = parseCorrelationId(raw) ?? randomUUID();
  return correlationContext.runWithCorrelation(id, handle);
}
