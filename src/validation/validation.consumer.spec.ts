import { Test, TestingModule } from '@nestjs/testing';
import { ValidationConsumer, ValidationRejectedError } from './validation.consumer';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';

describe('ValidationConsumer', () => {
  let consumer: ValidationConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const createDto = (overrides?: Partial<VideoValidationRequestedDto>): VideoValidationRequestedDto => ({
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
    occurredAt: '2026-08-27T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationConsumer,
        { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
        { provide: 'EVENT_PUBLISHER', useValue: publisher },
      ],
    }).compile();

    consumer = module.get<ValidationConsumer>(ValidationConsumer);
  });

  it('publishes VideoAccepted with the same request id and occurredAt for a valid message', async () => {
    const dto = createDto();
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
    const event = publisher.publishedEvents[0];
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.occurredAt).toBe(dto.occurredAt);
    expect(event.eventId).not.toBe(dto.eventId);
  });

  it('does not publish when processingRequestId is missing', async () => {
    const dto = createDto({ processingRequestId: '' });

    await expect(consumer.handleVideoValidationRequested(dto)).rejects.toThrow(
      ValidationRejectedError,
    );
    expect(publisher.publishedEvents).toHaveLength(0);
  });

  it('does not publish a second VideoAccepted for a duplicate eventId', async () => {
    const dto = createDto();
    await consumer.handleVideoValidationRequested(dto);
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
  });

  it('propagates publisher failure so the message would not be acknowledged', async () => {
    const dto = createDto();
    publisher.setNextResult(false);

    await expect(consumer.handleVideoValidationRequested(dto)).rejects.toThrow(
      'Failed to publish VideoAccepted',
    );
  });
});
