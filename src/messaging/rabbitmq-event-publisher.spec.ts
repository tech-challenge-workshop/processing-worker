import { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';
import { RabbitmqEventPublisher } from './rabbitmq-event-publisher';

describe('RabbitmqEventPublisher', () => {
  let publisher: RabbitmqEventPublisher;
  let videoAcceptedClient: { emit: jest.Mock };
  let processingCompletedClient: { emit: jest.Mock };

  const videoAccepted: VideoAcceptedDto = {
    eventId: 'accepted-1',
    processingRequestId: 'req-1',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  const processingCompleted: ProcessingCompletedDto = {
    eventId: 'completed-1',
    processingRequestId: 'req-1',
    attemptId: 'attempt-1',
    zipStorageKey: 'local/req-1/attempt-1/frames.zip',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  beforeEach(() => {
    videoAcceptedClient = { emit: jest.fn().mockReturnValue(of(undefined)) };
    processingCompletedClient = {
      emit: jest.fn().mockReturnValue(of(undefined)),
    };
    publisher = new RabbitmqEventPublisher(
      videoAcceptedClient as unknown as ClientProxy,
      processingCompletedClient as unknown as ClientProxy,
    );
  });

  it('emits VideoAccepted with the event payload', async () => {
    const result = await publisher.publish(videoAccepted);

    expect(result).toBe(true);
    expect(videoAcceptedClient.emit).toHaveBeenCalledWith(
      'VideoAccepted',
      videoAccepted,
    );
    expect(processingCompletedClient.emit).not.toHaveBeenCalled();
  });

  it('emits ProcessingCompleted with the event payload', async () => {
    const result = await publisher.publish(processingCompleted);

    expect(result).toBe(true);
    expect(processingCompletedClient.emit).toHaveBeenCalledWith(
      'ProcessingCompleted',
      processingCompleted,
    );
    expect(videoAcceptedClient.emit).not.toHaveBeenCalled();
  });

  it('returns false when the broker emit fails', async () => {
    videoAcceptedClient.emit.mockReturnValue(
      throwError(() => new Error('broker down')),
    );

    const result = await publisher.publish(videoAccepted);

    expect(result).toBe(false);
  });
});
