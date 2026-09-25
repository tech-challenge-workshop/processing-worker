import { Test, TestingModule } from '@nestjs/testing';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppModule } from './../src/app.module';
import { ChildProcessError } from './../src/media/child-process.runner';
import {
  FFMPEG_OPTIONS,
  FfmpegFrameExtractor,
} from './../src/media/ffmpeg-frame-extractor';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';
import { VideoValidationRequestedDto } from './../src/messaging/dto/video-validation-requested.dto';
import { outcomeEventId } from './../src/messaging/outcome-event-id';
import { frameArchiveKey } from './../src/processing/deterministic-frame-packager';
import { ProcessingConsumer } from './../src/processing/processing.consumer';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import { OBJECT_STORAGE } from './../src/storage/object-storage.interface';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { ValidationConsumer } from './../src/validation/validation.consumer';
import { zipEntries } from './support/zip-entries';

// RM-13, RM-16, RM-18: a redelivery costs nothing and no job leaves a
// temporary directory behind. The real AppModule runs real FFprobe, FFmpeg
// and archiver; only the publisher, the duplicate checker and the storage
// adapter are replaced, and the in-memory storage is the observation point.
//
// A redelivery that matters reaches a process that has not seen the message:
// another replica, or this one after a restart, since a message is only
// redelivered when it was never acknowledged. Each delivery below therefore
// boots its own AppModule with its own duplicate checker, sharing only the
// storage and the publisher.
const SAMPLE = join(__dirname, 'fixtures', 'sample-8s.mp4');
const SOURCE_KEY = 'sources/sample-8s.mp4';

describe('Real media: redelivery and cleanup (e2e)', () => {
  let publisher: FakeEventPublisher;
  let storage: InMemoryObjectStorage;
  let scratch: string;

  const processingJob = (
    overrides?: Partial<ProcessingQueuedDto>,
  ): ProcessingQueuedDto => ({
    eventId: 'queued-evt-1',
    processingRequestId: 'req-redelivery',
    ownerUserId: 'user-1',
    sourceStorageKey: SOURCE_KEY,
    attemptId: 'attempt-1',
    occurredAt: '2026-09-25T00:00:00Z',
    ...overrides,
  });

  const validationJob = (
    overrides?: Partial<VideoValidationRequestedDto>,
  ): VideoValidationRequestedDto => ({
    eventId: 'validation-evt-1',
    processingRequestId: 'req-validation',
    ownerUserId: 'user-1',
    sourceStorageKey: SOURCE_KEY,
    occurredAt: '2026-09-25T00:00:00Z',
    ...overrides,
  });

  /** One replica: its own module and duplicate checker, shared storage. */
  const replica = async (
    configure?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
  ): Promise<TestingModule> => {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    builder
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(new InMemoryDuplicateChecker())
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage);
    configure?.(builder);
    return builder.compile();
  };

  /** Counts real extractions and records the workspace each one ran in. */
  const watchExtractions = (module: TestingModule) => {
    const extractor = module.get(FfmpegFrameExtractor);
    const extract = extractor.extract.bind(extractor);
    const workspaces: string[] = [];
    const outcomes: unknown[] = [];
    const spy = jest
      .spyOn(extractor, 'extract')
      .mockImplementation(async (source, dir) => {
        workspaces.push(dirname(dir));
        expect(existsSync(dirname(dir))).toBe(true);
        try {
          return await extract(source, dir);
        } catch (error) {
          outcomes.push(error);
          throw error;
        }
      });
    return { spy, workspaces, outcomes };
  };

  /** Job directories this request left in the system temp directory. */
  const leftovers = (processingRequestId: string): string[] =>
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith(`fiapx-${processingRequestId}-`),
    );

  const storedArchive = async (key: string): Promise<Buffer> => {
    const path = join(scratch, 'downloaded.zip');
    await storage.download(key, path);
    return readFileSync(path);
  };

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    storage = new InMemoryObjectStorage();
    scratch = mkdtempSync(join(tmpdir(), 'real-media-e2e-'));
    await storage.upload(SOURCE_KEY, SAMPLE, 'video/mp4');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('when the same ProcessingQueued is delivered twice', () => {
    it('stores one archive, extracts once, and publishes two ProcessingCompleted identical down to their eventId', async () => {
      const first = await replica();
      const second = await replica();
      const firstExtractions = watchExtractions(first);
      const secondExtractions = watchExtractions(second);

      await first
        .get(ProcessingConsumer)
        .handleProcessingQueued(processingJob());
      await second
        .get(ProcessingConsumer)
        .handleProcessingQueued(processingJob());

      const key = frameArchiveKey(processingJob());
      // One stored object at the deterministic key, beside the source.
      expect(storage.keys().sort()).toEqual([key, SOURCE_KEY].sort());
      // One extraction across both deliveries: the second found the archive.
      expect(
        firstExtractions.spy.mock.calls.length +
          secondExtractions.spy.mock.calls.length,
      ).toBe(1);

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingCompleted',
        'ProcessingStarted',
        'ProcessingCompleted',
      ]);
      const [, completed, , republished] = publisher.published.map(
        (record) => record.event as unknown as Record<string, unknown>,
      );
      expect(completed.eventId).toBe(
        outcomeEventId('queued-evt-1', 'ProcessingCompleted'),
      );
      // occurredAt records when each was published; every other field,
      // eventId included, is the same event.
      const withoutOccurredAt = (event: Record<string, unknown>) => {
        const fields = { ...event };
        delete fields.occurredAt;
        return fields;
      };
      const completedFields = withoutOccurredAt(completed);
      const republishedFields = withoutOccurredAt(republished);
      expect(republishedFields).toEqual(completedFields);
      expect(republishedFields).toEqual({
        eventId: outcomeEventId('queued-evt-1', 'ProcessingCompleted'),
        processingRequestId: 'req-redelivery',
        attemptId: 'attempt-1',
        zipStorageKey: key,
      });
    });

    it('republishes a key that names a real archive of one entry per second', async () => {
      await (
        await replica()
      )
        .get(ProcessingConsumer)
        .handleProcessingQueued(processingJob());
      await (
        await replica()
      )
        .get(ProcessingConsumer)
        .handleProcessingQueued(processingJob());

      const republished = publisher.published[3].event as unknown as {
        zipStorageKey: string;
      };
      const entries = zipEntries(
        await storedArchive(republished.zipStorageKey),
      );
      // RM-11 orders entries by name, not by position: archiver appends files
      // asynchronously, so the physical order varies between runs.
      expect(entries.map((entry) => entry.name).sort()).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `frame-0000${n}.jpg`),
      );
    });
  });

  describe('when the same VideoValidationRequested is delivered twice', () => {
    it('publishes the same VideoAccepted the second time as the first', async () => {
      await (
        await replica()
      )
        .get(ValidationConsumer)
        .handleVideoValidationRequested(validationJob());
      await (
        await replica()
      )
        .get(ValidationConsumer)
        .handleVideoValidationRequested(validationJob());

      expect(publisher.publishedTypes).toEqual([
        'VideoAccepted',
        'VideoAccepted',
      ]);
      const [first, second] = publisher.publishedEvents;
      expect(second).toEqual(first);
      expect(first.eventId).toBe(
        outcomeEventId('validation-evt-1', 'VideoAccepted'),
      );
    });

    it('publishes the same VideoRejected the second time as the first', async () => {
      const notes = join(scratch, 'notes.mp4');
      await writeFile(notes, 'this is a text file renamed to .mp4\n');
      await storage.upload('sources/notes.mp4', notes, 'video/mp4');
      const job = validationJob({ sourceStorageKey: 'sources/notes.mp4' });

      await (
        await replica()
      )
        .get(ValidationConsumer)
        .handleVideoValidationRequested(job);
      await (
        await replica()
      )
        .get(ValidationConsumer)
        .handleVideoValidationRequested(job);

      expect(publisher.publishedTypes).toEqual([
        'VideoRejected',
        'VideoRejected',
      ]);
      const [first, second] = publisher.publishedEvents;
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        eventId: outcomeEventId('validation-evt-1', 'VideoRejected'),
        failureCode: 'FORMATO_INVALIDO',
      });
    });
  });

  describe('leaves no job directory in the system temp directory', () => {
    it('after a successful job', async () => {
      const job = processingJob({ processingRequestId: 'req-cleanup-ok' });
      const module = await replica();
      const { workspaces } = watchExtractions(module);

      await module.get(ProcessingConsumer).handleProcessingQueued(job);

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingCompleted',
      ]);
      expect(workspaces).toHaveLength(1);
      expect(existsSync(workspaces[0])).toBe(false);
      expect(leftovers('req-cleanup-ok')).toEqual([]);
    });

    it('after a failed job, storing nothing', async () => {
      const garbage = join(scratch, 'garbage.mp4');
      await writeFile(garbage, 'not a video at all');
      await storage.upload('sources/garbage.mp4', garbage, 'video/mp4');
      const job = processingJob({
        processingRequestId: 'req-cleanup-failed',
        sourceStorageKey: 'sources/garbage.mp4',
      });
      const module = await replica();
      const { workspaces, outcomes } = watchExtractions(module);

      await module.get(ProcessingConsumer).handleProcessingQueued(job);

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
      expect(publisher.published[1].event).toMatchObject({
        failureCode: 'PROCESSAMENTO_FALHOU',
      });
      expect(outcomes[0]).toBeInstanceOf(ChildProcessError);
      expect(await storage.head(frameArchiveKey(job))).toBeUndefined();
      expect(workspaces).toHaveLength(1);
      expect(existsSync(workspaces[0])).toBe(false);
      expect(leftovers('req-cleanup-failed')).toEqual([]);
    });

    it('after a job whose FFmpeg is killed by its timeout', async () => {
      const job = processingJob({ processingRequestId: 'req-cleanup-timeout' });
      const module = await replica((builder) =>
        builder
          .overrideProvider(FFMPEG_OPTIONS)
          .useValue({ binary: 'ffmpeg', threads: 1, timeoutMs: 1 }),
      );
      const { workspaces, outcomes } = watchExtractions(module);

      await module.get(ProcessingConsumer).handleProcessingQueued(job);

      // The job really was killed by the timeout, not failed some other way.
      expect(outcomes).toHaveLength(1);
      expect((outcomes[0] as ChildProcessError).timedOut).toBe(true);
      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
      expect(publisher.published[1].event).toMatchObject({
        failureCode: 'PROCESSAMENTO_FALHOU',
      });
      expect(await storage.head(frameArchiveKey(job))).toBeUndefined();
      expect(workspaces).toHaveLength(1);
      expect(existsSync(workspaces[0])).toBe(false);
      expect(leftovers('req-cleanup-timeout')).toEqual([]);
    });
  });
});
