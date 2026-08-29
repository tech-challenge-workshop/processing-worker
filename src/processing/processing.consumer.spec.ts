import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
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
      ],
    }).compile();

    consumer = module.get<ProcessingConsumer>(ProcessingConsumer);
  });

  it('publishes ProcessingCompleted with the same request id, attempt id, and deterministic zip key', async () => {
    const dto = createDto();
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
    const event = publisher.publishedEvents[0];
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect('attemptId' in event).toBe(true);
    expect(event.attemptId).toBe(dto.attemptId);
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

    expect(publisher.publishedEvents).toHaveLength(1);
  });

  it('propagates publisher failure so the message would not be acknowledged', async () => {
    const dto = createDto();
    publisher.setNextResult(false);

    await expect(consumer.handleProcessingQueued(dto)).rejects.toThrow(
      'Failed to publish ProcessingCompleted',
    );
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

    expect(publisher.publishedEvents).toHaveLength(1);
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
      'Failed to publish ProcessingCompleted',
    );

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });
});
