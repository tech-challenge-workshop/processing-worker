import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { ProcessingConsumer } from './../src/processing/processing.consumer';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { ProcessingQueuedDto } from './../src/messaging/dto/processing-queued.dto';

describe('Processing flow (e2e)', () => {
  let consumer: ProcessingConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('EVENT_PUBLISHER')
      .useValue(publisher)
      .overrideProvider('DUPLICATE_CHECKER')
      .useValue(duplicateChecker)
      .compile();

    consumer = moduleFixture.get<ProcessingConsumer>(ProcessingConsumer);
  });

  it('publishes ProcessingCompleted when a valid processing message is consumed', async () => {
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
    const event = publisher.publishedEvents[0];
    expect(event.processingRequestId).toBe(dto.processingRequestId);
    expect(event.attemptId).toBe(dto.attemptId);
    expect(event.eventId).not.toBe(dto.eventId);
    expect(event.eventId).toMatch(UUID_V4_REGEX);
    expect(event.zipStorageKey).toBe(
      `local/${dto.processingRequestId}/${dto.attemptId}/frames.zip`,
    );
  });

  it('does not publish a second ProcessingCompleted for a duplicate eventId', async () => {
    await consumer.handleProcessingQueued(dto);
    await consumer.handleProcessingQueued(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
  });
});
