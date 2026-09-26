import { INestApplication } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { AppModule } from './../src/app.module';
import { consumerOptions } from './../src/messaging/consumer-options';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';

// MSG-15: the two broker behaviours no fake channel can prove - the prefetch
// bound, and a malformed body dead-lettered on its first delivery - checked
// against a real RabbitMQ loaded with fiap-x-platform's definitions.json, so
// the queues, their `.dlq` and the dead-letter policy are the stack's own.
// Skipped when RABBITMQ_TEST_URL is unset on a developer machine; in CI an
// unset URL fails instead, so the suite can never go green by skipping.
const url = process.env.RABBITMQ_TEST_URL;

if (!url && process.env.CI) {
  describe('Worker against a real RabbitMQ', () => {
    it('requires RABBITMQ_TEST_URL in CI', () => {
      throw new Error('RABBITMQ_TEST_URL must be set in CI');
    });
  });
}

const DEADLINE_MS = 10000;
// Above the polling deadline, so a bound that never holds fails on its
// assertion rather than on Jest's 5 s default.
const TEST_TIMEOUT_MS = 30000;

/** Reads until the value is `expected` or the deadline passes; returns the last read. */
const eventually = async (
  read: () => Promise<number>,
  expected: number,
): Promise<number> => {
  const deadline = Date.now() + DEADLINE_MS;
  let last = await read();
  while (last !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  return last;
};

(url ? describe : describe.skip)('Worker against a real RabbitMQ', () => {
  const QUEUES = ['processing', 'video-validation', 'video-validation.dlq'];
  let connection: AmqpConnectionManager;
  let channel: ChannelWrapper;
  let app: INestApplication | undefined;
  let packagerCalls: number;

  // amqplib ships no types here, so the replies are typed at the boundary.
  const ready = async (queue: string): Promise<number> => {
    const reply = (await channel.checkQueue(queue)) as unknown as {
      messageCount: number;
    };
    return reply.messageCount;
  };

  const purge = async (): Promise<void> => {
    for (const queue of QUEUES) await channel.purgeQueue(queue);
  };

  // The Worker as main.ts composes it: both consumers, served with
  // consumerOptions, against the test broker. The packager never resolves,
  // so a delivered processing job stays in flight until the app closes.
  const startWorker = async (prefetchProcessing: string): Promise<void> => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(new FakeEventPublisher())
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(new InMemoryDuplicateChecker())
      .overrideProvider('FRAME_PACKAGER')
      .useValue({
        packageFrames: () => {
          packagerCalls++;
          return new Promise<string>(() => undefined);
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    const consumers = consumerOptions({
      RABBITMQ_URL: url,
      PREFETCH_PROCESSING: prefetchProcessing,
    });
    app.connectMicroservice<MicroserviceOptions>(consumers.validation);
    app.connectMicroservice<MicroserviceOptions>(consumers.processing);
    await app.startAllMicroservices();
    await app.init();
  };

  beforeAll(async () => {
    connection = amqp.connect([url as string]);
    channel = connection.createChannel({ json: false });
    await channel.waitForConnect();
  });

  beforeEach(async () => {
    packagerCalls = 0;
    await purge();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await purge();
  });

  afterAll(async () => {
    await channel.close();
    await connection.close();
  });

  // MSG-15 AC1
  it(
    'leaves the processing messages beyond a prefetch of 1 ready while the first is in flight',
    async () => {
      await startWorker('1');

      for (const n of [1, 2, 3]) {
        const dto: ProcessingQueuedDto = {
          eventId: `broker-e2e-${n}`,
          processingRequestId: `req-${n}`,
          ownerUserId: 'user-1',
          sourceStorageKey: `sources/${n}.mp4`,
          attemptId: `attempt-${n}`,
          occurredAt: '2026-09-26T00:00:00Z',
        };
        await channel.sendToQueue(
          'processing',
          Buffer.from(
            JSON.stringify({ pattern: 'ProcessingQueued', data: dto }),
          ),
        );
      }

      expect(await eventually(() => ready('processing'), 2)).toBe(2);
      // Still 2 once deliveries have had time to settle, and only one job ever
      // reached the packager: the bound holds, it was not a passing moment.
      await new Promise((r) => setTimeout(r, 1000));
      expect(await ready('processing')).toBe(2);
      expect(packagerCalls).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // MSG-15 AC2
  it(
    'dead-letters a non-JSON validation message on its first delivery',
    async () => {
      await startWorker('1');

      await channel.sendToQueue('video-validation', Buffer.from('not json'));

      expect(await eventually(() => ready('video-validation.dlq'), 1)).toBe(1);
      await new Promise((r) => setTimeout(r, 1000));
      expect(await ready('video-validation.dlq')).toBe(1);
      expect(await ready('video-validation')).toBe(0);

      const dead = (await channel.get('video-validation.dlq', {
        noAck: true,
      })) as unknown;
      expect(dead).not.toBe(false);
      const { content, properties } = dead as {
        content: Buffer;
        properties: { headers: Record<string, unknown> };
      };
      expect(content.toString()).toBe('not json');
      // Rejected by the Worker, once - not dropped by the delivery limit after
      // a series of requeues.
      const [death] = properties.headers['x-death'] as Array<{
        queue: string;
        reason: string;
        count: number;
      }>;
      expect(death).toMatchObject({
        queue: 'video-validation',
        reason: 'rejected',
        count: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
