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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .overrideProvider('RMQ_CLIENT')
      .useValue(fakeClient)
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
    const event = publisher.publishedEvents[1];
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.attemptId).toBe(dto.attemptId);
    expect(event.zipStorageKey).toBe(
      `local/${dto.processingRequestId}/${dto.attemptId}/frames.zip`,
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

  it('nacks failed publications with requeue and does not acknowledge success', async () => {
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

    await expect(
      validationConsumer.handleVideoValidationRequested(
        validationDto,
        validationCtx,
      ),
    ).rejects.toThrow();
    await expect(
      processingConsumer.handleProcessingQueued(processingDto, processingCtx),
    ).rejects.toThrow();

    expect(validationAck).not.toHaveBeenCalled();
    expect(processingAck).not.toHaveBeenCalled();
    expect(validationNack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(processingNack).toHaveBeenCalledWith(expect.anything(), false, true);
  });
});
