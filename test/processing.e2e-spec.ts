import { ProcessingCompletedDto } from './../src/messaging/dto/processing-completed.dto';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { ProcessingConsumer } from './../src/processing/processing.consumer';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';
import { EVENT_ROUTES } from './../src/messaging/event-routes';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipEntries } from './support/zip-entries';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import { OBJECT_STORAGE } from './../src/storage/object-storage.interface';
import { FfmpegFrameExtractor } from './../src/media/ffmpeg-frame-extractor';
import type { WorkerEvent } from './../src/messaging/event-publisher.interface';
import type { WorkerEventType } from './../src/messaging/event-routes';
import { outcomeEventId } from './../src/messaging/outcome-event-id';

// The source key the DTO names holds the real 8-second MP4, and the root
// binds the real media packager: ffmpeg and archiver run for every job here.
const SAMPLE = join(__dirname, 'fixtures', 'sample-8s.mp4');

describe('Processing flow (e2e)', () => {
  let consumer: ProcessingConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;
  let storage: InMemoryObjectStorage;

  // RM-18: an outcome's id is a v5 UUID derived from the consumed event.
  const UUID_V5_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const dto: ProcessingQueuedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    attemptId: 'attempt-1',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();
    storage = new InMemoryObjectStorage();
    await storage.upload(dto.sourceStorageKey, SAMPLE, 'video/mp4');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage)
      .compile();

    consumer = moduleFixture.get<ProcessingConsumer>(ProcessingConsumer);
  });

  const storedArchive = async (key: string): Promise<Buffer> => {
    const scratch = mkdtempSync(join(tmpdir(), 'fiapx-processing-e2e-'));
    try {
      await storage.download(key, join(scratch, 'frames.zip'));
      return readFileSync(join(scratch, 'frames.zip'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it('drives a real MP4 to ProcessingCompleted with an archive of one entry per second at the announced key', async () => {
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    const completed = publisher.publishedEvents[1] as ProcessingCompletedDto;
    const entries = zipEntries(await storedArchive(completed.zipStorageKey));
    expect(entries.map((e) => e.name).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `frame-0000${n}.jpg`),
    );
    expect(storage.keys().sort()).toEqual(
      [dto.sourceStorageKey, completed.zipStorageKey].sort(),
    );
  });

  it('publishes ProcessingStarted before extraction begins', async () => {
    const order: string[] = [];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue({
        publish: (type: WorkerEventType, event: WorkerEvent) => {
          order.push(`publish ${type}`);
          return publisher.publish(type, event);
        },
      })
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage)
      .compile();
    const real = moduleFixture.get(FfmpegFrameExtractor);
    const extract = real.extract.bind(real);
    jest.spyOn(real, 'extract').mockImplementation((source, dir) => {
      order.push('extract');
      return extract(source, dir);
    });

    await moduleFixture
      .get<ProcessingConsumer>(ProcessingConsumer)
      .handleProcessingQueued(dto);

    expect(order).toEqual([
      'publish ProcessingStarted',
      'extract',
      'publish ProcessingCompleted',
    ]);
  });

  it('publishes ProcessingCompleted when a valid processing message is consumed', async () => {
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    const event = publisher.publishedEvents[1] as ProcessingCompletedDto;
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.attemptId).toBe(dto.attemptId);
    expect(event.eventId).not.toBe(dto.eventId);
    expect(event.eventId).toMatch(UUID_V5_REGEX);
    expect(event.eventId).toBe(
      outcomeEventId(dto.eventId, 'ProcessingCompleted'),
    );
    expect(event.zipStorageKey).toBe(
      `local/${dto.processingRequestId}/${dto.attemptId}/frames.zip`,
    );
  });

  it('does not publish a second ProcessingCompleted for a duplicate eventId', async () => {
    await consumer.handleProcessingQueued(dto);
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
  });

  it('routes every published event to its own queue and pattern', async () => {
    await consumer.handleProcessingQueued(dto);

    // The defect this slice removes routed by payload shape. ProcessingStarted
    // carries no zipStorageKey, so it would have gone to the VideoAccepted
    // queue and reported success.
    for (const { type } of publisher.published) {
      expect(EVENT_ROUTES[type].pattern).toBe(type);
    }
    const queues = publisher.published.map((r) => EVENT_ROUTES[r.type].client);
    expect(new Set(queues).size).toBe(publisher.published.length);
  });

  describe('when the job fails', () => {
    let failing: ProcessingConsumer;

    beforeEach(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider('EVENT_PUBLISHER')
        .useValue(publisher)
        .overrideProvider('DUPLICATE_CHECKER')
        .useValue(duplicateChecker)
        .overrideProvider('FRAME_PACKAGER')
        .useValue({
          packageFrames: () => Promise.reject(new Error('packaging failed')),
        })
        .compile();

      failing = moduleFixture.get<ProcessingConsumer>(ProcessingConsumer);
    });

    it('publishes ProcessingStarted then ProcessingFailed, in that order', async () => {
      await failing.handleProcessingQueued(dto);

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
    });

    it('reports a safe failure code and the attempt it concerns', async () => {
      await failing.handleProcessingQueued(dto);

      const failed = publisher.published[1].event as unknown as {
        failureCode: string;
        attemptId: string;
        eventId: string;
      };
      expect(failed.failureCode).toBe('PROCESSAMENTO_FALHOU');
      expect(failed.attemptId).toBe(dto.attemptId);
      expect(failed.eventId).toMatch(UUID_V5_REGEX);
      expect(failed.eventId).toBe(
        outcomeEventId(dto.eventId, 'ProcessingFailed'),
      );
    });

    it('publishes nothing further when the failed job is redelivered', async () => {
      await failing.handleProcessingQueued(dto);
      await failing.handleProcessingQueued(dto);

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
    });
  });
});
