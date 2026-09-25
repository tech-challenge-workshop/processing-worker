import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
import { ProcessingCompletedDto } from '../messaging/dto/processing-completed.dto';
import { DeterministicFramePackager } from './deterministic-frame-packager';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { InMemoryDuplicateChecker } from '../validation/in-memory-duplicate-checker';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessError } from '../media/child-process.runner';
import { FfmpegFrameExtractor } from '../media/ffmpeg-frame-extractor';
import { TempWorkspace, WorkspaceOwner } from '../media/temp-workspace';
import { ZipBuilder } from '../media/zip-builder';
import { InMemoryObjectStorage } from '../storage/in-memory-object-storage';
import { frameArchiveKey } from './deterministic-frame-packager';
import { MediaFramePackager } from './media-frame-packager';
import { outcomeEventId } from '../messaging/outcome-event-id';
import { retryBackoffMs } from '../messaging/settle-failed-message';
import type { FramePackager } from './frame-packager.interface';
import {
  ProcessingConsumer,
  ProcessingRejectedError,
} from './processing.consumer';

describe('ProcessingConsumer', () => {
  let consumer: ProcessingConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  // RM-18: an outcome's id is a v5 UUID derived from the consumed event.
  const UUID_V5_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const createDto = (
    overrides?: Partial<ProcessingQueuedDto>,
  ): ProcessingQueuedDto => ({
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    attemptId: 'attempt-1',
    occurredAt: '2026-08-27T00:00:00Z',
    ...overrides,
  });

  const createContext = (): {
    ctx: RmqContext;
    ack: jest.Mock;
    nack: jest.Mock;
  } => {
    const ack = jest.fn();
    const nack = jest.fn();
    const ctx = {
      getMessage: () => ({}) as unknown as Record<string, unknown>,
      getChannelRef: () => ({ ack, nack }),
      getPattern: () => 'ProcessingQueued',
    } as unknown as RmqContext;
    return { ctx, ack, nack };
  };

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessingConsumer,
        { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
        { provide: 'EVENT_PUBLISHER', useValue: publisher },
        {
          provide: 'FRAME_PACKAGER',
          useValue: new DeterministicFramePackager(),
        },
      ],
    }).compile();

    consumer = module.get<ProcessingConsumer>(ProcessingConsumer);
  });

  it('publishes ProcessingCompleted with the same request id, attempt id, and deterministic zip key', async () => {
    const dto = createDto();
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    const event = publisher.publishedEvents[1] as ProcessingCompletedDto;
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect('attemptId' in event).toBe(true);
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

  it('does not publish when processingRequestId is missing', async () => {
    const dto = createDto({ processingRequestId: '' });

    await expect(consumer.handleProcessingQueued(dto)).rejects.toThrow(
      ProcessingRejectedError,
    );
    expect(publisher.publishedEvents).toHaveLength(0);
  });

  it('does not publish when attemptId is missing', async () => {
    const dto = createDto({ attemptId: '' });

    await expect(consumer.handleProcessingQueued(dto)).rejects.toThrow(
      ProcessingRejectedError,
    );
    expect(publisher.publishedEvents).toHaveLength(0);
  });

  it('does not publish a second ProcessingCompleted for a duplicate eventId', async () => {
    const dto = createDto();
    await consumer.handleProcessingQueued(dto);
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
  });

  it('propagates a ProcessingStarted publication failure and does not begin the work', async () => {
    const dto = createDto();
    publisher.setNextResult(false);

    await expect(consumer.handleProcessingQueued(dto)).rejects.toThrow(
      'Failed to publish ProcessingStarted',
    );

    // No outcome may follow a start the Catalog never observed.
    expect(publisher.publishedTypes).not.toContain('ProcessingCompleted');
    expect(publisher.publishedTypes).not.toContain('ProcessingFailed');
  });

  it('acknowledges a valid message after publishing ProcessingCompleted', async () => {
    const dto = createDto();
    const { ctx, ack, nack } = createContext();

    await consumer.handleProcessingQueued(dto, ctx);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate message without publishing again', async () => {
    const dto = createDto();
    await consumer.handleProcessingQueued(dto);
    const { ctx, ack, nack } = createContext();

    await consumer.handleProcessingQueued(dto, ctx);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('nacks a malformed message without requeue, without waiting the retry backoff', async () => {
    const dto = createDto({ processingRequestId: '' });
    const { ctx, ack, nack } = createContext();
    jest.useFakeTimers();
    try {
      // Settles with the clock frozen, so no backoff was waited (RM-20).
      await expect(consumer.handleProcessingQueued(dto, ctx)).rejects.toThrow(
        ProcessingRejectedError,
      );
    } finally {
      jest.useRealTimers();
    }

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('requeues a failed publication only after the retry backoff (RM-20)', async () => {
    const dto = createDto();
    publisher.setNextResult(false);
    const { ctx, ack, nack } = createContext();
    const backoff = retryBackoffMs();
    jest.useFakeTimers();
    try {
      const handled = expect(
        consumer.handleProcessingQueued(dto, ctx),
      ).rejects.toThrow('Failed to publish ProcessingStarted');
      await jest.advanceTimersByTimeAsync(backoff - 1);
      expect(nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await handled;
    } finally {
      jest.useRealTimers();
    }

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  describe('when packaging the frames fails', () => {
    const failingConsumer = async (): Promise<ProcessingConsumer> => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ProcessingConsumer,
          { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
          { provide: 'EVENT_PUBLISHER', useValue: publisher },
          {
            provide: 'FRAME_PACKAGER',
            useValue: {
              packageFrames: () => Promise.reject(new Error('ffmpeg blew up')),
            },
          },
        ],
      }).compile();
      return module.get<ProcessingConsumer>(ProcessingConsumer);
    };

    it('publishes ProcessingStarted then ProcessingFailed, in that order', async () => {
      const failing = await failingConsumer();

      await failing.handleProcessingQueued(createDto());

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
    });

    it('reports PROCESSAMENTO_FALHOU with the attempt it concerns', async () => {
      const failing = await failingConsumer();

      await failing.handleProcessingQueued(createDto());

      expect(publisher.published[1].event).toMatchObject({
        processingRequestId: 'req-1',
        attemptId: 'attempt-1',
        failureCode: 'PROCESSAMENTO_FALHOU',
      });
    });

    it('never publishes ProcessingCompleted for a failed job', async () => {
      const failing = await failingConsumer();

      await failing.handleProcessingQueued(createDto());

      expect(publisher.publishedTypes).not.toContain('ProcessingCompleted');
    });

    it('acknowledges the job, because the failure is terminal and must not be retried', async () => {
      const failing = await failingConsumer();
      const { ctx, ack, nack } = createContext();

      await failing.handleProcessingQueued(createDto(), ctx);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(nack).not.toHaveBeenCalled();
    });

    it('publishes no second outcome when the failed job is redelivered', async () => {
      const failing = await failingConsumer();

      await failing.handleProcessingQueued(createDto());
      await failing.handleProcessingQueued(createDto());

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
    });
  });

  it('publishes exactly one outcome per job, never both', async () => {
    await consumer.handleProcessingQueued(createDto());

    const outcomes = publisher.publishedTypes.filter(
      (type) => type === 'ProcessingCompleted' || type === 'ProcessingFailed',
    );
    expect(outcomes).toHaveLength(1);
  });

  // RM-12, RM-16: the real media packager, driven through the consumer, with
  // one stage failing at a time. Storage is in memory so what was stored is
  // observable; the extractor is a stand-in that writes frames the way FFmpeg
  // does, so no binary is needed to reach every stage.
  describe('with the media packager, when a stage fails', () => {
    class FlakyStorage extends InMemoryObjectStorage {
      failDownload?: Error;
      failUpload?: Error;
      download(key: string, destinationPath: string): Promise<void> {
        return this.failDownload
          ? Promise.reject(this.failDownload)
          : super.download(key, destinationPath);
      }
      upload(key: string, sourcePath: string, type: string): Promise<void> {
        return this.failUpload && key !== SOURCE_KEY
          ? Promise.reject(this.failUpload)
          : super.upload(key, sourcePath, type);
      }
    }

    class RecordingWorkspace extends TempWorkspace {
      dirs: string[] = [];
      withWorkspace<T>(
        owner: WorkspaceOwner,
        work: (dir: string) => Promise<T>,
      ): Promise<T> {
        return super.withWorkspace(owner, (dir) => {
          this.dirs.push(dir);
          return work(dir);
        });
      }
    }

    const SOURCE_KEY = 's3://bucket/key';
    let storage: FlakyStorage;
    let workspace: RecordingWorkspace;
    let extract: jest.Mock<Promise<string[]>, [string, string]>;
    let scratch: string;

    /** Writes `count` frames the way FFmpeg names them. */
    const writeFrames = (dir: string, count: number): string[] =>
      Array.from({ length: count }, (_, i) => {
        const path = join(dir, `frame-${String(i + 1).padStart(5, '0')}.jpg`);
        writeFileSync(path, `jpeg ${i + 1}`);
        return path;
      });

    const mediaConsumer = async (): Promise<ProcessingConsumer> => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ProcessingConsumer,
          { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
          { provide: 'EVENT_PUBLISHER', useValue: publisher },
          {
            provide: 'FRAME_PACKAGER',
            useValue: new MediaFramePackager(
              storage,
              { extract } as unknown as FfmpegFrameExtractor,
              new ZipBuilder(),
              workspace,
            ),
          },
        ],
      }).compile();
      return module.get<ProcessingConsumer>(ProcessingConsumer);
    };

    beforeEach(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'fiapx-consumer-spec-'));
      const source = join(scratch, 'source.mp4');
      writeFileSync(source, 'video bytes');
      storage = new FlakyStorage();
      await storage.upload(SOURCE_KEY, source, 'video/mp4');
      workspace = new RecordingWorkspace();
      extract = jest.fn((_source: string, dir: string) =>
        Promise.resolve(writeFrames(dir, 3)),
      );
    });

    afterEach(() => rmSync(scratch, { recursive: true, force: true }));

    const failures: [string, () => void][] = [
      [
        'FFmpeg exits non-zero after writing some frames',
        () =>
          extract.mockImplementation((_source, dir) => {
            writeFrames(dir, 2);
            return Promise.reject(
              new ChildProcessError(
                'ffmpeg exited with code 1',
                'ffmpeg',
                1,
                null,
                'Invalid data found when processing input',
                false,
              ),
            );
          }),
      ],
      [
        'FFmpeg is killed after its timeout',
        () =>
          extract.mockRejectedValue(
            new ChildProcessError(
              'ffmpeg timed out after 600000 ms',
              'ffmpeg',
              null,
              'SIGKILL',
              '',
              true,
            ),
          ),
      ],
      [
        'storage is unreachable while reading the source',
        () => {
          storage.failDownload = new Error('connect ECONNREFUSED minio:9000');
        },
      ],
      [
        'the archive cannot be written to storage',
        () => {
          storage.failUpload = new Error('connect ECONNREFUSED minio:9000');
        },
      ],
    ];

    it.each(failures)(
      'when %s: publishes exactly one ProcessingFailed with PROCESSAMENTO_FALHOU and stores nothing',
      async (_stage, inject) => {
        inject();
        const consumer = await mediaConsumer();

        await consumer.handleProcessingQueued(createDto());

        expect(publisher.publishedTypes).toEqual([
          'ProcessingStarted',
          'ProcessingFailed',
        ]);
        expect(publisher.published[1].event).toMatchObject({
          processingRequestId: 'req-1',
          attemptId: 'attempt-1',
          failureCode: 'PROCESSAMENTO_FALHOU',
        });
        // Nothing was stored, partial or otherwise: only the source remains.
        expect(storage.keys()).toEqual([SOURCE_KEY]);
        expect(
          await storage.head(frameArchiveKey(createDto())),
        ).toBeUndefined();
        expect(workspace.dirs).toHaveLength(1);
        expect(existsSync(workspace.dirs[0])).toBe(false);
      },
    );

    it('starts no second business attempt for a failed job: one extraction, acknowledged, not requeued', async () => {
      failures[0][1]();
      const consumer = await mediaConsumer();
      const first = createContext();
      const redelivery = createContext();

      await consumer.handleProcessingQueued(createDto(), first.ctx);
      await consumer.handleProcessingQueued(createDto(), redelivery.ctx);

      expect(extract).toHaveBeenCalledTimes(1);
      expect(first.ack).toHaveBeenCalledTimes(1);
      expect(first.nack).not.toHaveBeenCalled();
      expect(redelivery.nack).not.toHaveBeenCalled();
      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingFailed',
      ]);
    });

    it('publishes exactly one ProcessingCompleted, and no ProcessingFailed, when no stage fails', async () => {
      const consumer = await mediaConsumer();

      await consumer.handleProcessingQueued(createDto());

      expect(publisher.publishedTypes).toEqual([
        'ProcessingStarted',
        'ProcessingCompleted',
      ]);
      expect(storage.keys().sort()).toEqual(
        [SOURCE_KEY, frameArchiveKey(createDto())].sort(),
      );
    });
  });

  // RM-18: a redelivery reaches a replica (or a restarted process) that has
  // not seen the message, so each consumption below has its own duplicate
  // checker. Every republished outcome must carry the id the first one did.
  describe('when the same message is consumed twice', () => {
    const replica = async (
      packager: FramePackager,
    ): Promise<ProcessingConsumer> => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ProcessingConsumer,
          {
            provide: 'DUPLICATE_CHECKER',
            useValue: new InMemoryDuplicateChecker(),
          },
          { provide: 'EVENT_PUBLISHER', useValue: publisher },
          { provide: 'FRAME_PACKAGER', useValue: packager },
        ],
      }).compile();
      return module.get<ProcessingConsumer>(ProcessingConsumer);
    };

    const failingPackager: FramePackager = {
      packageFrames: () => Promise.reject(new Error('ffmpeg blew up')),
    };

    it.each<[string, FramePackager]>([
      ['ProcessingCompleted', new DeterministicFramePackager()],
      ['ProcessingFailed', failingPackager],
    ])(
      'publishes ProcessingStarted and %s under the same eventIds both times',
      async (outcome, packager) => {
        await (await replica(packager)).handleProcessingQueued(createDto());
        await (await replica(packager)).handleProcessingQueued(createDto());

        expect(publisher.publishedTypes).toEqual([
          'ProcessingStarted',
          outcome,
          'ProcessingStarted',
          outcome,
        ]);
        const ids = publisher.publishedEvents.map((e) => e.eventId);
        expect(ids[2]).toBe(ids[0]);
        expect(ids[3]).toBe(ids[1]);
      },
    );

    it('gives ProcessingStarted and ProcessingCompleted of one job different ids', async () => {
      await consumer.handleProcessingQueued(createDto());

      const [started, completed] = publisher.publishedEvents;
      expect(started.eventId).toBe(
        outcomeEventId('evt-1', 'ProcessingStarted'),
      );
      expect(completed.eventId).toBe(
        outcomeEventId('evt-1', 'ProcessingCompleted'),
      );
      expect(started.eventId).not.toBe(completed.eventId);
    });

    it('gives a new attempt, which arrives as a new message, new ids', async () => {
      await (
        await replica(new DeterministicFramePackager())
      ).handleProcessingQueued(createDto());
      await (
        await replica(new DeterministicFramePackager())
      ).handleProcessingQueued(
        createDto({ eventId: 'evt-2', attemptId: 'attempt-2' }),
      );

      const ids = publisher.publishedEvents.map((e) => e.eventId);
      expect(new Set(ids).size).toBe(4);
    });
  });
});
