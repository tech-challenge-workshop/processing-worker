import { ProcessingCompletedDto } from './../src/messaging/dto/processing-completed.dto';
import { Test, TestingModule } from '@nestjs/testing';
import { ClientProxy } from '@nestjs/microservices';
import { RmqContext } from '@nestjs/microservices';
import { of } from 'rxjs';
import { AppModule } from './../src/app.module';
import { ValidationConsumer } from './../src/validation/validation.consumer';
import { ProcessingConsumer } from './../src/processing/processing.consumer';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { VideoValidationRequestedDto } from './../src/messaging/dto/video-validation-requested.dto';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';
import { join } from 'node:path';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import { OBJECT_STORAGE } from './../src/storage/object-storage.interface';
import { retryBackoffMs } from './../src/messaging/settle-failed-message';

// The source key the DTOs below name holds a real MP4, so the real FFprobe
// validator accepts it and the real media packager extracts it.
const SAMPLE = join(__dirname, 'fixtures', 'sample-8s.mp4');

describe('Local Docker Integration (e2e)', () => {
  let validationConsumer: ValidationConsumer;
  let processingConsumer: ProcessingConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const createValidationDto = (): VideoValidationRequestedDto => ({
    eventId: 'validation-evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    occurredAt: '2026-08-27T00:00:00Z',
  });

  const createProcessingDto = (): ProcessingQueuedDto => ({
    eventId: 'processing-evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    attemptId: 'attempt-1',
    occurredAt: '2026-08-27T00:00:00Z',
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
      getPattern: () => 'pattern',
    } as unknown as RmqContext;
    return { ctx, ack, nack };
  };

  const fakeClient = {
    emit: jest.fn().mockReturnValue(of(undefined)),
    status: of('connected'),
    connect: jest.fn().mockReturnValue(of(undefined)),
    close: jest.fn(),
  } as unknown as ClientProxy;

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();
    const storage = new InMemoryObjectStorage();
    await storage.upload(
      createValidationDto().sourceStorageKey,
      SAMPLE,
      'video/mp4',
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .overrideProvider('RMQ_CLIENT')
      .useValue(fakeClient)
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage)
      .compile();

    validationConsumer =
      moduleFixture.get<ValidationConsumer>(ValidationConsumer);
    processingConsumer =
      moduleFixture.get<ProcessingConsumer>(ProcessingConsumer);
  });

  it('acknowledges a valid VideoValidationRequested and publishes VideoAccepted', async () => {
    const dto = createValidationDto();
    const { ctx, ack, nack } = createContext();

    await validationConsumer.handleVideoValidationRequested(dto, ctx);

    expect(publisher.publishedEvents).toHaveLength(1);
    expect(publisher.publishedEvents[0].processingRequestId).toBe(
      dto.processingRequestId,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges a valid ProcessingQueued and publishes ProcessingCompleted', async () => {
    const dto = createProcessingDto();
    const { ctx, ack, nack } = createContext();

    await processingConsumer.handleProcessingQueued(dto, ctx);

    expect(publisher.publishedTypes).toEqual([
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    const event = publisher.publishedEvents[1] as ProcessingCompletedDto;
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.attemptId).toBe(dto.attemptId);
    expect(event.zipStorageKey).toBe(
      `zips/${dto.processingRequestId}/${dto.attemptId}/frames.zip`,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges duplicate event IDs without publishing a second event', async () => {
    const validationDto = createValidationDto();
    const processingDto = createProcessingDto();

    await validationConsumer.handleVideoValidationRequested(validationDto);
    await processingConsumer.handleProcessingQueued(processingDto);

    const { ctx: validationCtx, ack: validationAck } = createContext();
    const { ctx: processingCtx, ack: processingAck } = createContext();

    await validationConsumer.handleVideoValidationRequested(
      validationDto,
      validationCtx,
    );
    await processingConsumer.handleProcessingQueued(
      processingDto,
      processingCtx,
    );

    expect(publisher.publishedTypes).toEqual([
      'VideoAccepted',
      'ProcessingStarted',
      'ProcessingCompleted',
    ]);
    expect(validationAck).toHaveBeenCalledTimes(1);
    expect(processingAck).toHaveBeenCalledTimes(1);
  });

  it('nacks malformed validation and processing messages without requeue', async () => {
    const validationDto = createValidationDto();
    validationDto.processingRequestId = '';
    const processingDto = createProcessingDto();
    processingDto.attemptId = '';

    const {
      ctx: validationCtx,
      ack: validationAck,
      nack: validationNack,
    } = createContext();
    const {
      ctx: processingCtx,
      ack: processingAck,
      nack: processingNack,
    } = createContext();

    await expect(
      validationConsumer.handleVideoValidationRequested(
        validationDto,
        validationCtx,
      ),
    ).rejects.toThrow();
    await expect(
      processingConsumer.handleProcessingQueued(processingDto, processingCtx),
    ).rejects.toThrow();

    expect(publisher.publishedEvents).toHaveLength(0);
    expect(validationAck).not.toHaveBeenCalled();
    expect(processingAck).not.toHaveBeenCalled();
    expect(validationNack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false,
    );
    expect(processingNack).toHaveBeenCalledWith(
      expect.anything(),
      false,
      false,
    );
  });

  it('nacks failed publications with requeue, only after the retry backoff, and does not acknowledge success', async () => {
    publisher.setNextResult(false);
    const validationDto = createValidationDto();
    const processingDto = createProcessingDto();

    const {
      ctx: validationCtx,
      ack: validationAck,
      nack: validationNack,
    } = createContext();
    const {
      ctx: processingCtx,
      ack: processingAck,
      nack: processingNack,
    } = createContext();

    const backoff = retryBackoffMs();
    // Both handlers do real I/O (FFprobe runs first for validation), so the
    // clock only moves once both publish attempts have failed - the point at
    // which settling begins. Ticks and immediates stay real so that I/O flows.
    let attempts = 0;
    let bothAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => (bothAttempted = resolve));
    const publish = publisher.publish.bind(publisher);
    jest.spyOn(publisher, 'publish').mockImplementation(async (type, event) => {
      const result = await publish(type, event);
      if (++attempts === 2) bothAttempted();
      return result;
    });
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const validationHandled = expect(
        validationConsumer.handleVideoValidationRequested(
          validationDto,
          validationCtx,
        ),
      ).rejects.toThrow();
      const processingHandled = expect(
        processingConsumer.handleProcessingQueued(processingDto, processingCtx),
      ).rejects.toThrow();
      await attempted;
      // RM-20: neither is requeued before the backoff has elapsed.
      await jest.advanceTimersByTimeAsync(backoff - 1);
      expect(validationNack).not.toHaveBeenCalled();
      expect(processingNack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await validationHandled;
      await processingHandled;
    } finally {
      jest.useRealTimers();
    }

    expect(validationAck).not.toHaveBeenCalled();
    expect(processingAck).not.toHaveBeenCalled();
    expect(validationNack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(processingNack).toHaveBeenCalledWith(expect.anything(), false, true);
  });
});
