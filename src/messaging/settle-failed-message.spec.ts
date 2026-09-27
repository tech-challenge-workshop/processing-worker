import { ProcessingRejectedError } from '../processing/processing.consumer';
import { ValidationRejectedError } from '../validation/validation.consumer';
import {
  DEFAULT_RETRY_BACKOFF_MS,
  isPermanentFailure,
  MessageRejectedError,
  retryBackoffMs,
  settleFailedMessage,
} from './settle-failed-message';

// RM-20: a message that is itself wrong is dead-lettered at once; anything
// else is requeued, but only after the retry backoff. ROB-09: only a
// MessageRejectedError is "itself wrong" - Nest nacks a non-JSON body before
// the Worker runs, so a SyntaxError reaching this helper is transient.
describe('settleFailedMessage', () => {
  const message = { content: Buffer.from('{}') };
  const channel = () => ({ nack: jest.fn() });

  const parseError = (): unknown => {
    try {
      JSON.parse('{not json');
    } catch (error) {
      return error;
    }
    throw new Error('JSON.parse accepted a body that is not JSON');
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each<[string, () => unknown]>([
    ['MessageRejectedError', () => new MessageRejectedError('body is wrong')],
    [
      'ValidationRejectedError',
      () => new ValidationRejectedError('processingRequestId is required'),
    ],
    [
      'ProcessingRejectedError',
      () => new ProcessingRejectedError('attemptId is required'),
    ],
  ])(
    'dead-letters a %s without requeue and without waiting the backoff',
    async (_name, error) => {
      const ch = channel();

      // Awaited with the clock frozen: it can only settle if it never waits.
      await settleFailedMessage(ch, message, error(), 1000);

      expect(ch.nack).toHaveBeenCalledTimes(1);
      expect(ch.nack).toHaveBeenCalledWith(message, false, false);
    },
  );

  it('requeues any other error only once the backoff has elapsed', async () => {
    const ch = channel();

    const settled = settleFailedMessage(
      ch,
      message,
      new Error('connect ECONNREFUSED minio:9000'),
      1000,
    );
    await jest.advanceTimersByTimeAsync(999);
    expect(ch.nack).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await settled;
    expect(ch.nack).toHaveBeenCalledTimes(1);
    expect(ch.nack).toHaveBeenCalledWith(message, false, true);
  });

  it('requeues a SyntaxError only once the backoff has elapsed, as a transient failure', async () => {
    const ch = channel();

    const settled = settleFailedMessage(ch, message, parseError(), 1000);
    await jest.advanceTimersByTimeAsync(999);
    expect(ch.nack).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await settled;
    expect(ch.nack).toHaveBeenCalledTimes(1);
    expect(ch.nack).toHaveBeenCalledWith(message, false, true);
  });

  it('waits the configured RABBITMQ_RETRY_BACKOFF_MS when no backoff is passed', async () => {
    const previous = process.env.RABBITMQ_RETRY_BACKOFF_MS;
    process.env.RABBITMQ_RETRY_BACKOFF_MS = '250';
    try {
      const ch = channel();

      const settled = settleFailedMessage(ch, message, new Error('down'));
      await jest.advanceTimersByTimeAsync(249);
      expect(ch.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await settled;
      expect(ch.nack).toHaveBeenCalledWith(message, false, true);
    } finally {
      if (previous === undefined) delete process.env.RABBITMQ_RETRY_BACKOFF_MS;
      else process.env.RABBITMQ_RETRY_BACKOFF_MS = previous;
    }
  });
});

describe('isPermanentFailure', () => {
  it('is true for a MessageRejectedError', () => {
    expect(isPermanentFailure(new MessageRejectedError('body is wrong'))).toBe(
      true,
    );
  });

  it('is false for a SyntaxError', () => {
    expect(isPermanentFailure(new SyntaxError('Unexpected token'))).toBe(false);
  });

  it('treats a TypeError as transient, so a bug is retried and logged rather than silently dead-lettered', () => {
    expect(isPermanentFailure(new TypeError('x is undefined'))).toBe(false);
  });
});

describe('retryBackoffMs', () => {
  const previous = process.env.RABBITMQ_RETRY_BACKOFF_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.RABBITMQ_RETRY_BACKOFF_MS;
    else process.env.RABBITMQ_RETRY_BACKOFF_MS = previous;
  });

  it.each([undefined, 'soon', '-5', ''])(
    'falls back to the 1000 ms default when the value is %p',
    (configured) => {
      if (configured === undefined) {
        delete process.env.RABBITMQ_RETRY_BACKOFF_MS;
      } else {
        process.env.RABBITMQ_RETRY_BACKOFF_MS = configured;
      }

      expect(DEFAULT_RETRY_BACKOFF_MS).toBe(1000);
      expect(retryBackoffMs()).toBe(1000);
    },
  );

  it('reads a configured value', () => {
    process.env.RABBITMQ_RETRY_BACKOFF_MS = '250';
    expect(retryBackoffMs()).toBe(250);
  });
});
