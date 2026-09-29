import { correlationContext } from '../observability/correlation-context';
import { withMessageCorrelation } from './with-correlation';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('withMessageCorrelation (OBS-31, OBS-34)', () => {
  const seenBy = async (payload: unknown): Promise<string | undefined> => {
    let seen: string | undefined;
    await withMessageCorrelation(payload, () => {
      seen = correlationContext.getCorrelationId();
      return Promise.resolve();
    });
    return seen;
  };

  it("sets the context from the message's correlationId before handling", async () => {
    expect(await seenBy({ eventId: 'e-1', correlationId: ' w-7 ' })).toBe(
      'w-7',
    );
  });

  it('clears the context once the handler has settled', async () => {
    const result = await withMessageCorrelation({ correlationId: 'w-7' }, () =>
      Promise.resolve('handled'),
    );

    expect(result).toBe('handled');
    expect(correlationContext.getCorrelationId()).toBeUndefined();
  });

  it('clears the context when the handler throws, and rethrows', async () => {
    await expect(
      withMessageCorrelation({ correlationId: 'w-7' }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');

    expect(correlationContext.getCorrelationId()).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a message without the field', { eventId: 'e-1' }],
    ['a payload that is not an object', undefined],
  ])(
    'generates a fresh id for %s and still runs the handler',
    async (_label, payload) => {
      const handler = jest.fn(() => Promise.resolve());

      await withMessageCorrelation(payload, handler);
      const first = await seenBy(payload);
      const second = await seenBy(payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(first).toMatch(UUID);
      expect(second).toMatch(UUID);
      expect(first).not.toBe(second);
    },
  );

  it.each<[string, unknown]>([
    ['a number', 123],
    ['an object', { id: 'w-7' }],
    ['null', null],
  ])(
    'replaces %s with a generated id and still runs the handler, never coercing it (L-010)',
    async (_label, correlationId) => {
      const handler = jest.fn(() => Promise.resolve());

      await withMessageCorrelation({ eventId: 'e-1', correlationId }, handler);
      const seen = await seenBy({ eventId: 'e-1', correlationId });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(seen).toMatch(UUID);
    },
  );
});
