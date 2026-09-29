import { ModuleRef } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { correlationContext } from '../observability/correlation-context';
import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';
import {
  EVENT_ROUTES,
  WORKER_EVENT_TYPES,
  type WorkerEventType,
} from './event-routes';
import { RabbitmqEventPublisher } from './rabbitmq-event-publisher';

describe('RabbitmqEventPublisher', () => {
  let publisher: RabbitmqEventPublisher;
  let clients: Record<string, { emit: jest.Mock }>;
  let moduleRef: { get: jest.Mock };

  const videoAccepted: VideoAcceptedDto = {
    eventId: 'accepted-1',
    processingRequestId: 'req-1',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  const processingCompleted: ProcessingCompletedDto = {
    eventId: 'completed-1',
    processingRequestId: 'req-1',
    attemptId: 'attempt-1',
    zipStorageKey: 'zips/req-1/attempt-1/frames.zip',
    occurredAt: '2026-08-27T00:00:00Z',
  };

  beforeEach(() => {
    clients = {};
    for (const type of WORKER_EVENT_TYPES) {
      clients[EVENT_ROUTES[type].client] = {
        emit: jest.fn().mockReturnValue(of(undefined)),
      };
    }
    moduleRef = { get: jest.fn((token: string) => clients[token]) };
    publisher = new RabbitmqEventPublisher(moduleRef as unknown as ModuleRef);
  });

  it.each(WORKER_EVENT_TYPES)(
    'sends %s to its own client with its own pattern',
    async (type: WorkerEventType) => {
      const payload = { eventId: `${type}-1`, processingRequestId: 'req-1' };

      const result = await publisher.publish(
        type,
        payload as unknown as VideoAcceptedDto,
      );

      expect(result).toBe(true);
      expect(clients[EVENT_ROUTES[type].client].emit).toHaveBeenCalledWith(
        EVENT_ROUTES[type].pattern,
        payload,
      );

      const others = WORKER_EVENT_TYPES.filter((t) => t !== type).map(
        (t) => EVENT_ROUTES[t].client,
      );
      for (const token of new Set(others)) {
        if (token === EVENT_ROUTES[type].client) continue;
        expect(clients[token].emit).not.toHaveBeenCalled();
      }
    },
  );

  it('routes a payload carrying zipStorageKey by its declared type, not its shape', async () => {
    // Under the previous implementation the presence of zipStorageKey decided
    // the destination. Declaring the type must now win over the payload shape.
    await publisher.publish('VideoAccepted', {
      ...videoAccepted,
      zipStorageKey: 'should-not-decide-the-route',
    });

    expect(
      clients[EVENT_ROUTES.VideoAccepted.client].emit,
    ).toHaveBeenCalledWith('VideoAccepted', expect.anything());
    expect(
      clients[EVENT_ROUTES.ProcessingCompleted.client].emit,
    ).not.toHaveBeenCalled();
  });

  it('routes a payload without zipStorageKey to ProcessingCompleted when the caller says so', async () => {
    await publisher.publish('ProcessingCompleted', videoAccepted);

    expect(
      clients[EVENT_ROUTES.ProcessingCompleted.client].emit,
    ).toHaveBeenCalledWith('ProcessingCompleted', videoAccepted);
    expect(
      clients[EVENT_ROUTES.VideoAccepted.client].emit,
    ).not.toHaveBeenCalled();
  });

  it('throws for an event type with no configured route', async () => {
    await expect(
      publisher.publish('NotAnEvent' as WorkerEventType, videoAccepted),
    ).rejects.toThrow('No route configured for event type NotAnEvent');
  });

  it('returns false when the broker emit fails', async () => {
    clients[EVENT_ROUTES.VideoAccepted.client].emit.mockReturnValue(
      throwError(() => new Error('broker down')),
    );

    const result = await publisher.publish('VideoAccepted', videoAccepted);

    expect(result).toBe(false);
  });

  it('emits the payload unchanged', async () => {
    await publisher.publish('ProcessingCompleted', processingCompleted);

    expect(
      clients[EVENT_ROUTES.ProcessingCompleted.client].emit,
    ).toHaveBeenCalledWith('ProcessingCompleted', processingCompleted);
  });

  describe('correlation id (OBS-32, OBS-33)', () => {
    const emittedPayload = (type: WorkerEventType): Record<string, unknown> => {
      const calls = clients[EVENT_ROUTES[type].client].emit.mock.calls as Array<
        [string, Record<string, unknown>]
      >;
      const call = calls.find(
        ([pattern]) => pattern === EVENT_ROUTES[type].pattern,
      );
      return call![1];
    };

    it('stamps the context id on every event type it emits', async () => {
      await correlationContext.runWithCorrelation('w-7', async () => {
        for (const type of WORKER_EVENT_TYPES) {
          await publisher.publish(type, { ...videoAccepted });
        }
      });

      for (const type of WORKER_EVENT_TYPES) {
        expect(emittedPayload(type)).toEqual({
          ...videoAccepted,
          correlationId: 'w-7',
        });
      }
    });

    it('omits the field, rather than sending null, outside a correlation scope', async () => {
      for (const type of WORKER_EVENT_TYPES) {
        await publisher.publish(type, { ...videoAccepted });
      }

      for (const type of WORKER_EVENT_TYPES) {
        expect(emittedPayload(type)).toEqual(videoAccepted);
        expect('correlationId' in emittedPayload(type)).toBe(false);
      }
    });

    it('reads the id at emit time, so concurrent scopes each stamp their own', async () => {
      const emit = clients[EVENT_ROUTES.VideoAccepted.client].emit;
      let releaseFirst!: () => void;
      const firstMayPublish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = correlationContext.runWithCorrelation('w-1', async () => {
        await firstMayPublish;
        await publisher.publish('VideoAccepted', { ...videoAccepted });
      });
      const second = correlationContext.runWithCorrelation('w-2', async () => {
        await publisher.publish('VideoAccepted', { ...videoAccepted });
        releaseFirst();
      });
      await Promise.all([first, second]);

      expect(
        emit.mock.calls.map(
          ([, payload]) => (payload as Record<string, unknown>).correlationId,
        ),
      ).toEqual(['w-2', 'w-1']);
    });

    it('lets the context id win over one a caller put on the event', async () => {
      await correlationContext.runWithCorrelation('w-7', () =>
        publisher.publish('VideoAccepted', {
          ...videoAccepted,
          correlationId: 'stale',
        }),
      );

      expect(emittedPayload('VideoAccepted').correlationId).toBe('w-7');
    });
  });
});
