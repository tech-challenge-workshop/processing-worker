import { FakeEventPublisher } from './fake-event-publisher';
import { VideoAcceptedDto } from './dto/video-accepted.dto';

describe('FakeEventPublisher', () => {
  let publisher: FakeEventPublisher;
  const event: VideoAcceptedDto = {
    eventId: 'accepted-1',
    processingRequestId: 'req-1',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  beforeEach(() => {
    publisher = new FakeEventPublisher();
  });

  it('records a published event', async () => {
    await publisher.publish(event);
    expect(publisher.publishedEvents).toEqual([event]);
  });

  it('returns true by default', async () => {
    const result = await publisher.publish(event);
    expect(result).toBe(true);
  });

  it('returns false when configured to fail', async () => {
    publisher.setNextResult(false);
    const result = await publisher.publish(event);
    expect(result).toBe(false);
  });
});
