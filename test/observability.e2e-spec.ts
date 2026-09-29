import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { createServer, connect, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import './support/outcome-broker-url';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';
import { consumerOptions } from './../src/messaging/consumer-options';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';
import { VideoValidationRequestedDto } from './../src/messaging/dto/video-validation-requested.dto';
import { LOG_DESTINATION } from './../src/observability/logger.config';
import { workerMetrics } from './../src/observability/metrics';
import { FramePackager } from './../src/processing/frame-packager.interface';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import { S3ObjectStorage } from './../src/storage/s3-object-storage';
import { brokerSuiteMode } from './../src/testing/broker-guard';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { VideoValidator } from './../src/validation/video-validator.interface';

// OBS-31..42 on a real RabbitMQ: the Worker as main.ts composes it
// (configureApp: the pino logger, both consumers, readiness; plus the real
// outcome publisher, /metrics, /health) consumes from the
// broker and publishes to the stack's outcome queues. The two consumed queues
// get suite-private names, so a broker suite running in a parallel Jest
// worker never takes these messages; they are deleted afterwards. Same
// RABBITMQ_TEST_URL guard as test/broker.e2e-spec.ts.
const url = process.env.RABBITMQ_TEST_URL;
// The Worker logs at its production level here: every line goes to the
// suite's capture stream (LOG_DESTINATION), not to stdout.
process.env.LOG_LEVEL = 'info';
const mode = brokerSuiteMode(process.env);

if (mode === 'fail') {
  describe('Observability against a real RabbitMQ', () => {
    it('requires RABBITMQ_TEST_URL in CI', () => {
      throw new Error('RABBITMQ_TEST_URL must be set in CI');
    });
  });
}

const DEADLINE_MS = 10000;
const TEST_TIMEOUT_MS = 30000;
const VALIDATION_QUEUE = 'obs-e2e.video-validation';
const PROCESSING_QUEUE = 'obs-e2e.processing';
const OUTCOME_QUEUES = [
  'video.accepted',
  'video.rejected',
  'processing.started',
  'processing.completed',
  'processing.failed',
];
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `read` until `done` holds or the deadline passes; returns the last read. */
const eventually = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> => {
  const deadline = Date.now() + DEADLINE_MS;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await sleep(100);
    last = await read();
  }
  return last;
};

/** The value of one exposition series, or undefined when it is absent. */
const seriesValue = (
  exposition: string,
  series: string,
): number | undefined => {
  const line = exposition
    .split('\n')
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

const describeBroker = mode === 'run' ? describe : describe.skip;

describeBroker('Observability against a real RabbitMQ', () => {
  let connection: AmqpConnectionManager;
  let channel: ChannelWrapper;
  let app: INestApplication<App> | undefined;
  // Every line the Worker's pino logger writes during a test, in order.
  // nestjs-pino builds its root logger once per process, so the capture
  // stream reads this binding rather than holding one array.
  let logLines: string[] = [];

  // The storage adapters' own download failures: an S3 object without a
  // readable body, and an in-memory key with no object.
  const unreadableS3 = new S3ObjectStorage(
    { send: () => Promise.resolve({ Body: undefined }) },
    'fiapx',
  );
  const emptyMemory = new InMemoryObjectStorage();
  const neverWritten = join(tmpdir(), 'obs-e2e-never-written');

  // Accepts or rejects, completes or fails, by the request id, so one run
  // can produce all four outcomes. `unreadable-` and `missing-` jobs fail in
  // the storage adapter, as a real download would.
  const validator: VideoValidator = {
    validate: async (dto) => {
      if (dto.processingRequestId.startsWith('unreadable')) {
        await unreadableS3.download(dto.sourceStorageKey, neverWritten);
      }
      if (dto.processingRequestId.startsWith('missing')) {
        await emptyMemory.download(dto.sourceStorageKey, neverWritten);
      }
      return dto.processingRequestId.startsWith('reject')
        ? { accepted: false, failureCode: 'FORMATO_INVALIDO' }
        : { accepted: true };
    },
  };
  // A `hold-` job waits in the packager until the test releases it, so the
  // app can begin shutting down while the job is in flight.
  let packagerEntered: () => void = () => undefined;
  let releasePackager: () => void = () => undefined;
  const packager: FramePackager = {
    packageFrames: (dto) => {
      if (dto.processingRequestId.startsWith('hold')) {
        packagerEntered();
        return new Promise((resolve) => {
          releasePackager = () =>
            resolve(`zips/${dto.processingRequestId}.zip`);
        });
      }
      return dto.processingRequestId.startsWith('fail')
        ? Promise.reject(new Error('ffmpeg blew up'))
        : Promise.resolve(`zips/${dto.processingRequestId}.zip`);
    },
  };

  const purgeOutcomes = async (): Promise<void> => {
    for (const queue of OUTCOME_QUEUES) await channel.purgeQueue(queue);
  };

  const startWorker = async (brokerUrl = url as string): Promise<void> => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(new InMemoryDuplicateChecker())
      .overrideProvider('VIDEO_VALIDATOR')
      .useValue(validator)
      .overrideProvider('FRAME_PACKAGER')
      .useValue(packager)
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (line: string) => logLines.push(line) })
      .compile();
    app = moduleFixture.createNestApplication({ bufferLogs: true });
    configureApp(
      app,
      consumerOptions({
        RABBITMQ_URL: brokerUrl,
        RABBITMQ_VIDEO_VALIDATION_QUEUE: VALIDATION_QUEUE,
        RABBITMQ_PROCESSING_QUEUE: PROCESSING_QUEUE,
      }),
    );
    await app.startAllMicroservices();
    await app.init();
    app.flushLogs();
  };

  const send = async (
    queue: string,
    pattern: string,
    data: unknown,
  ): Promise<void> => {
    await channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify({ pattern, data })),
    );
  };

  const validationRequested = (
    overrides: Partial<VideoValidationRequestedDto> = {},
  ): VideoValidationRequestedDto => ({
    eventId: `obs-e2e-${Math.random()}`,
    processingRequestId: 'accept-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'sources/accept-1.mp4',
    occurredAt: '2026-09-28T00:00:00Z',
    ...overrides,
  });

  const processingQueued = (
    overrides: Partial<ProcessingQueuedDto> = {},
  ): ProcessingQueuedDto => ({
    eventId: `obs-e2e-${Math.random()}`,
    processingRequestId: 'complete-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'sources/complete-1.mp4',
    attemptId: 'attempt-1',
    occurredAt: '2026-09-28T00:00:00Z',
    ...overrides,
  });

  /** The next outcome message on `queue`, unwrapped from Nest's envelope. */
  const nextOutcome = async (
    queue: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const message = await eventually(
      () => channel.get(queue, { noAck: true }) as Promise<unknown>,
      (got) => got !== false,
    );
    if (message === false) return undefined;
    const { content } = message as { content: Buffer };
    const envelope = JSON.parse(content.toString()) as {
      data: Record<string, unknown>;
    };
    return envelope.data;
  };

  const http = () => request(app!.getHttpServer());

  const scrape = async (): Promise<string> => {
    const response = await http().get('/metrics');
    expect(response.status).toBe(200);
    return response.text;
  };

  beforeAll(async () => {
    connection = amqp.connect([url as string]);
    channel = connection.createChannel({ json: false });
    await channel.waitForConnect();
  });

  beforeEach(async () => {
    logLines = [];
    workerMetrics.resetMetrics();
    await purgeOutcomes();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await purgeOutcomes();
  });

  afterAll(async () => {
    await channel.deleteQueue(VALIDATION_QUEUE);
    await channel.deleteQueue(PROCESSING_QUEUE);
    await channel.close();
    await connection.close();
  });

  describe('correlation id (OBS-31..34)', () => {
    it(
      'republishes the consumed id on VideoAccepted',
      async () => {
        await startWorker();

        await send(
          VALIDATION_QUEUE,
          'VideoValidationRequested',
          validationRequested({ correlationId: 'w-7' }),
        );

        expect(await nextOutcome('video.accepted')).toMatchObject({
          processingRequestId: 'accept-1',
          correlationId: 'w-7',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'republishes the consumed id on ProcessingStarted and ProcessingCompleted',
      async () => {
        await startWorker();

        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({ correlationId: 'p-3' }),
        );

        expect(await nextOutcome('processing.started')).toMatchObject({
          processingRequestId: 'complete-1',
          correlationId: 'p-3',
        });
        expect(await nextOutcome('processing.completed')).toMatchObject({
          processingRequestId: 'complete-1',
          correlationId: 'p-3',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'republishes the consumed id on VideoRejected and ProcessingFailed',
      async () => {
        await startWorker();

        await send(
          VALIDATION_QUEUE,
          'VideoValidationRequested',
          validationRequested({
            processingRequestId: 'reject-1',
            correlationId: 'w-8',
          }),
        );
        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({
            processingRequestId: 'fail-1',
            correlationId: 'p-4',
          }),
        );

        expect(await nextOutcome('video.rejected')).toMatchObject({
          processingRequestId: 'reject-1',
          correlationId: 'w-8',
        });
        expect(await nextOutcome('processing.failed')).toMatchObject({
          processingRequestId: 'fail-1',
          correlationId: 'p-4',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'flows a generated id when the message has none, and settles the message',
      async () => {
        await startWorker();

        await send(
          VALIDATION_QUEUE,
          'VideoValidationRequested',
          validationRequested(),
        );

        const accepted = await nextOutcome('video.accepted');
        expect(accepted?.correlationId).toMatch(UUID_V4_REGEX);
        expect(await scrape()).toContain(
          'fiapx_validation_total{outcome="accepted"} 1',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'replaces a numeric id with a generated one without failing the message (L-010)',
      async () => {
        await startWorker();

        await send(VALIDATION_QUEUE, 'VideoValidationRequested', {
          ...validationRequested(),
          correlationId: 7,
        });

        const accepted = await nextOutcome('video.accepted');
        expect(accepted?.correlationId).toMatch(UUID_V4_REGEX);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('metrics (OBS-37..40, OBS-42)', () => {
    const OUTCOME_SERIES = [
      'fiapx_validation_total{outcome="accepted"}',
      'fiapx_validation_total{outcome="rejected"}',
      'fiapx_processing_total{outcome="completed"}',
      'fiapx_processing_total{outcome="failed"}',
    ];
    const outcomeSum = (exposition: string): number =>
      OUTCOME_SERIES.reduce(
        (sum, series) => sum + (seriesValue(exposition, series) ?? 0),
        0,
      );

    it(
      'shows exactly the four outcomes, their durations, and no job in flight after one run of each',
      async () => {
        await startWorker();

        await send(
          VALIDATION_QUEUE,
          'VideoValidationRequested',
          validationRequested({ processingRequestId: 'accept-1' }),
        );
        await send(
          VALIDATION_QUEUE,
          'VideoValidationRequested',
          validationRequested({ processingRequestId: 'reject-1' }),
        );
        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({ processingRequestId: 'complete-1' }),
        );
        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({ processingRequestId: 'fail-1' }),
        );

        await eventually(scrape, (text) => outcomeSum(text) >= 4);
        // Held a moment longer, so a late double count would show.
        await sleep(500);
        const exposition = await scrape();

        for (const series of OUTCOME_SERIES) {
          expect(seriesValue(exposition, series)).toBe(1);
        }
        expect(
          seriesValue(exposition, 'fiapx_processing_duration_seconds_count'),
        ).toBe(2);
        expect(
          seriesValue(exposition, 'fiapx_jobs_inflight{queue="validation"}'),
        ).toBe(0);
        expect(
          seriesValue(exposition, 'fiapx_jobs_inflight{queue="processing"}'),
        ).toBe(0);
        // The outcomes were really published, not only counted.
        expect(await nextOutcome('video.accepted')).toMatchObject({
          processingRequestId: 'accept-1',
        });
        expect(await nextOutcome('video.rejected')).toMatchObject({
          processingRequestId: 'reject-1',
        });
        expect(await nextOutcome('processing.completed')).toMatchObject({
          processingRequestId: 'complete-1',
        });
        expect(await nextOutcome('processing.failed')).toMatchObject({
          processingRequestId: 'fail-1',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'returns the gauge to zero after a handler throws, counting no outcome (L-009)',
      async () => {
        await startWorker();
        const ready = async (): Promise<number> => {
          const reply = (await channel.checkQueue(PROCESSING_QUEUE)) as {
            messageCount: number;
          };
          return reply.messageCount;
        };

        // No attemptId: the handler throws and the message is rejected.
        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({ attemptId: '' }),
        );

        // Gone from the queue: delivered, handled, and rejected.
        expect(await eventually(ready, (n) => n === 0)).toBe(0);
        await sleep(500);
        const exposition = await scrape();

        expect(
          seriesValue(exposition, 'fiapx_jobs_inflight{queue="processing"}'),
        ).toBe(0);
        expect(outcomeSum(exposition)).toBe(0);
        expect(
          seriesValue(exposition, 'fiapx_processing_duration_seconds_count'),
        ).toBe(0);
        expect(await ready()).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'serves /metrics unauthenticated as text 0.0.4 and counts health traffic by route template',
      async () => {
        await startWorker();

        await http().get('/health/live').expect(200);
        const response = await http().get('/metrics');

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(
          'text/plain; version=0.0.4',
        );
        expect(response.text).toContain(
          'fiapx_http_requests_total{method="GET",route="/health/live",status="200"} 1',
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('logs through the Worker logger wiring (OBS-31, OBS-35, OBS-36)', () => {
    const parsed = (): Array<Record<string, unknown>> =>
      logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const queueDepth = async (queue: string): Promise<number> => {
      const reply = (await channel.checkQueue(queue)) as {
        messageCount: number;
      };
      return reply.messageCount;
    };

    const expectEveryLineStructured = (): void => {
      expect(logLines.length).toBeGreaterThan(0);
      for (const line of parsed()) {
        expect(line).toEqual(
          expect.objectContaining({
            timestamp: expect.any(Number) as unknown,
            level: expect.any(Number) as unknown,
            msg: expect.any(String) as unknown,
            service: 'processing-worker',
          }),
        );
      }
    };

    it(
      'writes every line as JSON, and a line logged inside the handler carries the consumed id and no storage key',
      async () => {
        await startWorker();
        const entered = new Promise<void>(
          (resolve) => (packagerEntered = resolve),
        );

        await send(
          PROCESSING_QUEUE,
          'ProcessingQueued',
          processingQueued({
            processingRequestId: 'hold-1',
            sourceStorageKey: 'sources/secret-key.mp4',
            correlationId: 'w-7',
          }),
        );
        await entered;
        // The same job republished the consumed id before the packager ran.
        expect(await nextOutcome('processing.started')).toMatchObject({
          processingRequestId: 'hold-1',
          correlationId: 'w-7',
        });
        // The app shuts down while the job is in the packager; released
        // after, the job logs its left-for-redelivery warning inside the
        // message's scope.
        await app!.close();
        app = undefined;
        releasePackager();
        const inHandler = (): Array<Record<string, unknown>> =>
          parsed().filter(
            (line) =>
              typeof line.msg === 'string' && line.msg.includes('hold-1'),
          );
        await eventually(
          () => Promise.resolve(inHandler()),
          (lines) => lines.length > 0,
        );
        // The unacked message went back to the queue with the connection.
        await eventually(
          () => queueDepth(PROCESSING_QUEUE),
          (n) => n === 1,
        );
        await channel.purgeQueue(PROCESSING_QUEUE);

        expectEveryLineStructured();
        expect(inHandler()).toHaveLength(1);
        expect(inHandler()[0]).toMatchObject({
          level: 40,
          context: 'ProcessingConsumer',
          correlationId: 'w-7',
        });
        expect(logLines.join('\n')).not.toContain('secret-key');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'keeps the storage key out of the lines logged when storage fails a job',
      async () => {
        await startWorker();

        for (const processingRequestId of ['unreadable-1', 'missing-1']) {
          await send(
            VALIDATION_QUEUE,
            'VideoValidationRequested',
            validationRequested({
              processingRequestId,
              sourceStorageKey: 'sources/secret-key.mp4',
              correlationId: 'w-9',
            }),
          );
        }
        const storageErrors = (): string[] =>
          logLines.filter((line) =>
            /has no readable body|has no object/.test(line),
          );
        // Both failures reached the log (each is retried, so it may repeat).
        const logged = await eventually(
          () => Promise.resolve(storageErrors()),
          (lines) =>
            lines.some((line) => line.includes('has no readable body')) &&
            lines.some((line) => line.includes('has no object')),
        );
        await app!.close();
        app = undefined;
        // Both transient failures were requeued; nothing else consumes them.
        await eventually(
          () => queueDepth(VALIDATION_QUEUE),
          (n) => n === 2,
        );
        await channel.purgeQueue(VALIDATION_QUEUE);

        expect(
          logged.some((line) => line.includes('has no readable body')),
        ).toBe(true);
        expect(logged.some((line) => line.includes('has no object'))).toBe(
          true,
        );
        expectEveryLineStructured();
        expect(logLines.join('\n')).not.toContain('secret-key');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('health (OBS-41)', () => {
    // A TCP relay to the real broker, so this Worker alone can lose it: the
    // relay closes and drops its sockets, and every reconnect is refused.
    let relay: Server;
    let sockets: Socket[];

    const cutRelay = (): void => {
      relay.close();
      sockets.forEach((socket) => socket.destroy());
    };

    beforeEach(async () => {
      const broker = new URL(url as string);
      sockets = [];
      relay = createServer((client) => {
        const upstream = connect(Number(broker.port || 5672), broker.hostname);
        sockets.push(client, upstream);
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      await new Promise<void>((resolve) =>
        relay.listen(0, '127.0.0.1', resolve),
      );
    });

    afterEach(() => {
      cutRelay();
    });

    it(
      'answers /health 503 once the broker is unreachable while /health/live and /metrics answer 200',
      async () => {
        const broker = new URL(url as string);
        const { port } = relay.address() as { port: number };
        await startWorker(
          `amqp://${broker.username}:${broker.password}@127.0.0.1:${port}`,
        );

        const whileConnected = await eventually(
          () => http().get('/health'),
          (response) => response.status === 200,
        );
        expect(whileConnected.status).toBe(200);

        cutRelay();

        const readiness = await eventually(
          () => http().get('/health'),
          (response) => response.status === 503,
        );
        expect(readiness.status).toBe(503);
        expect(readiness.body).toMatchObject({
          status: 'error',
          rabbitmq: false,
        });
        const liveness = await http().get('/health/live');
        expect(liveness.status).toBe(200);
        expect(liveness.body).toEqual({ status: 'ok' });
        expect((await http().get('/metrics')).status).toBe(200);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
