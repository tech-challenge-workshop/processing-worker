import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { ValidationConsumer } from './../src/validation/validation.consumer';
import { FakeEventPublisher } from './../src/messaging/fake-event-publisher';
import { InMemoryDuplicateChecker } from './../src/validation/in-memory-duplicate-checker';
import { VideoValidationRequestedDto } from './../src/messaging/dto/video-validation-requested.dto';

describe('Validation flow (e2e)', () => {
  let consumer: ValidationConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const dto: VideoValidationRequestedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
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

    consumer = moduleFixture.get<ValidationConsumer>(ValidationConsumer);
  });

  it('publishes VideoAccepted when a valid validation message is consumed', async () => {
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
    expect(publisher.publishedEvents[0].processingRequestId).toBe(
      dto.processingRequestId,
    );
  });

  it('does not publish a second VideoAccepted for a duplicate eventId', async () => {
    await consumer.handleVideoValidationRequested(dto);
    await consumer.handleVideoValidationRequested(dto);

    expect(publisher.publishedEvents).toHaveLength(1);
  });
});
