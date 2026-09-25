import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from './../src/app.module';
import { ValidationConsumer } from './../src/validation/validation.consumer';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { VideoValidationRequestedDto } from './../src/messaging/dto/video-validation-requested.dto';
import { VideoRejectedDto } from './../src/messaging/dto/video-rejected.dto';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import {
  OBJECT_STORAGE,
  ObjectHead,
} from './../src/storage/object-storage.interface';
import { outcomeEventId } from './../src/messaging/outcome-event-id';
import { retryBackoffMs } from './../src/messaging/settle-failed-message';

const SAMPLE = join(__dirname, 'fixtures', 'sample-8s.mp4');

// The real AppModule with the real FFprobe validator: only the publisher,
// the duplicate checker and the storage adapter are replaced, and the
// storage double holds real bytes, so ffprobe decides every outcome here.
describe('Validation flow (e2e)', () => {
  let consumer: ValidationConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;
  let storage: InMemoryObjectStorage;
  let scratch: string;

  // RM-18: an outcome's id is a v5 UUID derived from the consumed event.
  const UUID_V5_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const dto: VideoValidationRequestedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  const boot = async (objectStorage: InMemoryObjectStorage): Promise<void> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .overrideProvider(OBJECT_STORAGE)
      .useValue(objectStorage)
      .compile();

    consumer = moduleFixture.get<ValidationConsumer>(ValidationConsumer);
  };

  const store = async (key: string, bytes: string): Promise<void> => {
    const path = join(scratch, 'object');
    writeFileSync(path, bytes);
    await storage.upload(key, path, 'video/mp4');
  };

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();
    storage = new InMemoryObjectStorage();
    scratch = mkdtempSync(join(tmpdir(), 'fiapx-validation-e2e-'));
    await storage.upload(dto.sourceStorageKey, SAMPLE, 'video/mp4');
    await boot(storage);
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('publishes VideoAccepted when a valid validation message is consumed', async () => {
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
    const event = publisher.publishedEvents[0];
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.eventId).not.toBe(dto.eventId);
    expect(event.eventId).toMatch(UUID_V5_REGEX);
    expect(event.eventId).toBe(outcomeEventId(dto.eventId, 'VideoAccepted'));
  });

  it('does not publish a second VideoAccepted for a duplicate eventId', async () => {
    await consumer.handleVideoValidationRequested(dto);
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
  });

  it('drives a real readable MP4 to VideoAccepted and nothing else', async () => {
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedTypes).toEqual(['VideoAccepted']);
  });

  it('drives a non-video file to VideoRejected with FORMATO_INVALIDO', async () => {
    await store('sources/notes.mp4', 'this is a text file renamed to .mp4\n');

    await consumer.handleVideoValidationRequested({
      ...dto,
      sourceStorageKey: 'sources/notes.mp4',
    });

    expect(publisher.publishedTypes).toEqual(['VideoRejected']);
    const rejected = publisher.publishedEvents[0] as VideoRejectedDto;
    expect(rejected.failureCode).toBe('FORMATO_INVALIDO');
    expect(rejected.processingRequestId).toBe(dto.processingRequestId);
  });

  it('rejects a source object that does not exist with FORMATO_INVALIDO', async () => {
    await consumer.handleVideoValidationRequested({
      ...dto,
      sourceStorageKey: 'sources/never-uploaded.mp4',
    });

    expect(publisher.publishedTypes).toEqual(['VideoRejected']);
    expect((publisher.publishedEvents[0] as VideoRejectedDto).failureCode).toBe(
      'FORMATO_INVALIDO',
    );
  });

  it('publishes nothing and requeues, only after the retry backoff, when storage is unreachable during validation', async () => {
    class UnreachableStorage extends InMemoryObjectStorage {
      head(): Promise<ObjectHead | undefined> {
        return Promise.reject(new Error('connect ECONNREFUSED minio:9000'));
      }
    }
    await boot(new UnreachableStorage());
    const ack = jest.fn();
    const nack = jest.fn();
    const ctx = {
      getMessage: () => ({}),
      getChannelRef: () => ({ ack, nack }),
    } as unknown as RmqContext;

    const backoff = retryBackoffMs();
    jest.useFakeTimers();
    try {
      const handled = expect(
        consumer.handleVideoValidationRequested(dto, ctx),
      ).rejects.toThrow('ECONNREFUSED');
      // RM-20: never an immediate requeue against a dependency that is down.
      await jest.advanceTimersByTimeAsync(backoff - 1);
      expect(nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await handled;
    } finally {
      jest.useRealTimers();
    }

    expect(publisher.publishedEvents).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });
});
