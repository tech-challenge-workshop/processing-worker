import { NestFactory } from '@nestjs/core';
import { RmqOptions, ServerRMQ } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  consumerOptions,
  DEFAULT_PREFETCH_PROCESSING,
  DEFAULT_PREFETCH_VALIDATION,
} from './../src/messaging/consumer-options';

// RM-14: every consumed queue carries a finite prefetch. Nest's default is 0,
// which RabbitMQ reads as unlimited, so a value that is absent or unusable
// must fall back to the documented default, never through to the transport.
describe('Bounded work in flight (e2e)', () => {
  const PREFETCH_VARS = ['PREFETCH_VALIDATION', 'PREFETCH_PROCESSING'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(PREFETCH_VARS.map((v) => [v, process.env[v]]));
    for (const v of PREFETCH_VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const v of PREFETCH_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    jest.restoreAllMocks();
  });

  it('applies the documented defaults, 20 for validation and 1 for processing, when nothing is configured', () => {
    const { validation, processing } = consumerOptions({});

    expect(DEFAULT_PREFETCH_VALIDATION).toBe(20);
    expect(DEFAULT_PREFETCH_PROCESSING).toBe(1);
    expect(validation.options).toMatchObject({
      queue: 'video-validation',
      prefetchCount: 20,
      isGlobalPrefetchCount: false,
    });
    expect(processing.options).toMatchObject({
      queue: 'processing',
      prefetchCount: 1,
      isGlobalPrefetchCount: false,
    });
  });

  it('applies the configured prefetch to each queue', () => {
    const { validation, processing } = consumerOptions({
      PREFETCH_VALIDATION: '8',
      PREFETCH_PROCESSING: '2',
    });

    expect(validation.options?.prefetchCount).toBe(8);
    expect(processing.options?.prefetchCount).toBe(2);
  });

  it.each(['0', '-3', '1.5', 'many', ''])(
    'never passes %p through as a prefetch: it falls back to the default instead of unlimited',
    (configured) => {
      const { validation, processing } = consumerOptions({
        PREFETCH_VALIDATION: configured,
        PREFETCH_PROCESSING: configured,
      });

      expect(validation.options?.prefetchCount).toBe(20);
      expect(processing.options?.prefetchCount).toBe(1);
    },
  );

  // Drives Nest's own RMQ server with the options above against a recording
  // channel, so what is asserted is what the transport actually sends to the
  // broker - not what the options object happens to contain.
  const setUpChannel = async (options: RmqOptions) => {
    const calls: string[] = [];
    const channel = {
      assertQueue: jest.fn((queue: string) => {
        calls.push('assertQueue');
        return Promise.resolve({ queue });
      }),
      assertExchange: jest.fn(() => Promise.resolve()),
      bindQueue: jest.fn(() => Promise.resolve()),
      prefetch: jest.fn(() => {
        calls.push('prefetch');
        return Promise.resolve();
      }),
      consume: jest.fn(() => {
        calls.push('consume');
      }),
    };
    const server = new ServerRMQ(options.options ?? {});
    await server.setupChannel(channel, () => undefined);
    return { channel, calls };
  };

  it.each([
    ['validation', 'video-validation', 20],
    ['processing', 'processing', 1],
  ] as const)(
    'makes the transport set a per-consumer prefetch on the %s channel before consuming, without touching the queue declaration',
    async (name, queue, prefetch) => {
      const { channel, calls } = await setUpChannel(consumerOptions({})[name]);

      expect(channel.prefetch).toHaveBeenCalledWith(prefetch, false);
      expect(calls.indexOf('prefetch')).toBeLessThan(calls.indexOf('consume'));
      // A channel setting, not a queue argument (AD-011): the declaration is
      // exactly what it was before prefetch existed.
      expect(channel.assertQueue).toHaveBeenCalledWith(queue, {
        durable: true,
      });
    },
  );

  it('serves both queues from main.ts with a finite prefetch', async () => {
    const connected: RmqOptions[] = [];
    let listened!: () => void;
    const started = new Promise<void>((resolve) => (listened = resolve));
    const app = {
      connectMicroservice: (options: RmqOptions) => {
        connected.push(options);
        return { status: of('disconnected') };
      },
      get: () => ({ setConnected: () => undefined }),
      startAllMicroservices: () => Promise.resolve(),
      listen: () => {
        listened();
        return Promise.resolve();
      },
    };
    jest.spyOn(NestFactory, 'create').mockResolvedValue(app as never);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./../src/main');
    await started;

    expect(connected.map((c) => c.options)).toEqual([
      expect.objectContaining({
        queue: 'video-validation',
        prefetchCount: 20,
        isGlobalPrefetchCount: false,
      }),
      expect.objectContaining({
        queue: 'processing',
        prefetchCount: 1,
        isGlobalPrefetchCount: false,
      }),
    ]);
  });
});
