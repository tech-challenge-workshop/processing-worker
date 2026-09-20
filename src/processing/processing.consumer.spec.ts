import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
import { ProcessingCompletedDto } from '../messaging/dto/processing-completed.dto';
import { DeterministicFramePackager } from './deterministic-frame-packager';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { InMemoryDuplicateChecker } from '../validation/in-memory-duplicate-checker';
import {
  ProcessingConsumer,
  ProcessingRejectedError,
} from './processing.consumer';

describe('ProcessingConsumer', () => {
  let consumer: ProcessingConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    expect(event.eventId).toMatch(UUID_V4_REGEX);
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

  it('nacks a malformed message without requeue', async () => {
    const dto = createDto({ processingRequestId: '' });
    const { ctx, ack, nack } = createContext();

    await expect(consumer.handleProcessingQueued(dto, ctx)).rejects.toThrow(
      ProcessingRejectedError,
    );

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('nacks a failed publication with requeue', async () => {
    const dto = createDto();
    publisher.setNextResult(false);
    const { ctx, ack, nack } = createContext();

    await expect(consumer.handleProcessingQueued(dto, ctx)).rejects.toThrow(
      'Failed to publish ProcessingStarted',
    );

    expect(ack).not.toHaveBeenCalled();
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
});
