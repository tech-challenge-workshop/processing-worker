import { Test, TestingModule } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import {
  ValidationConsumer,
  ValidationRejectedError,
} from './validation.consumer';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { AcceptAllVideoValidator } from './accept-all-video-validator';
import type {
  FailureCode,
  ValidationOutcome,
  VideoValidator,
} from './video-validator.interface';

class StubValidator implements VideoValidator {
  constructor(private readonly outcome: ValidationOutcome) {}
  validate(): Promise<ValidationOutcome> {
    return Promise.resolve(this.outcome);
  }
}

describe('ValidationConsumer', () => {
  let consumer: ValidationConsumer;
  let publisher: FakeEventPublisher;
  let duplicateChecker: InMemoryDuplicateChecker;

  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const createDto = (
    overrides?: Partial<VideoValidationRequestedDto>,
  ): VideoValidationRequestedDto => ({
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 's3://bucket/key',
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
      getPattern: () => 'VideoValidationRequested',
    } as unknown as RmqContext;
    return { ctx, ack, nack };
  };

  beforeEach(async () => {
    publisher = new FakeEventPublisher();
    duplicateChecker = new InMemoryDuplicateChecker();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationConsumer,
        { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
        { provide: 'EVENT_PUBLISHER', useValue: publisher },
        { provide: 'VIDEO_VALIDATOR', useValue: new AcceptAllVideoValidator() },
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
    expect(event.eventId).toMatch(UUID_V4_REGEX);
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

  it('acknowledges a valid message after publishing VideoAccepted', async () => {
    const dto = createDto();
    const { ctx, ack, nack } = createContext();

    await consumer.handleVideoValidationRequested(dto, ctx);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate message without publishing again', async () => {
    const dto = createDto();
    await consumer.handleVideoValidationRequested(dto);
    const { ctx, ack, nack } = createContext();

    await consumer.handleVideoValidationRequested(dto, ctx);

    expect(publisher.publishedEvents).toHaveLength(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('nacks a malformed message without requeue', async () => {
    const dto = createDto({ processingRequestId: '' });
    const { ctx, ack, nack } = createContext();

    await expect(
      consumer.handleVideoValidationRequested(dto, ctx),
    ).rejects.toThrow(ValidationRejectedError);

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('nacks a failed publication with requeue', async () => {
    const dto = createDto();
    publisher.setNextResult(false);
    const { ctx, ack, nack } = createContext();

    await expect(
      consumer.handleVideoValidationRequested(dto, ctx),
    ).rejects.toThrow('Failed to publish VideoAccepted');

    expect(ack).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  describe('when the validator rejects the video', () => {
    const rejectingConsumer = async (
      failureCode: FailureCode,
    ): Promise<ValidationConsumer> => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ValidationConsumer,
          { provide: 'DUPLICATE_CHECKER', useValue: duplicateChecker },
          { provide: 'EVENT_PUBLISHER', useValue: publisher },
          {
            provide: 'VIDEO_VALIDATOR',
            useValue: new StubValidator({ accepted: false, failureCode }),
          },
        ],
      }).compile();
      return module.get<ValidationConsumer>(ValidationConsumer);
    };

    it.each<FailureCode>(['FORMATO_INVALIDO', 'DURACAO_EXCEDIDA'])(
      'publishes VideoRejected carrying %s and never VideoAccepted',
      async (failureCode) => {
        const rejecting = await rejectingConsumer(failureCode);
        const { ctx, ack } = createContext();

        await rejecting.handleVideoValidationRequested(createDto(), ctx);

        expect(publisher.published).toHaveLength(1);
        const record = publisher.published[0];
        expect(record.type).toBe('VideoRejected');
        expect(record.event).toMatchObject({
          processingRequestId: 'req-1',
          failureCode,
          occurredAt: '2026-08-27T00:00:00Z',
        });
        expect(publisher.publishedTypes).not.toContain('VideoAccepted');
        expect(ack).toHaveBeenCalled();
      },
    );

    it('generates a fresh well-formed eventId for the rejection', async () => {
      const rejecting = await rejectingConsumer('FORMATO_INVALIDO');
      const { ctx } = createContext();

      await rejecting.handleVideoValidationRequested(createDto(), ctx);

      const event = publisher.published[0].event as { eventId: string };
      expect(event.eventId).toMatch(UUID_V4_REGEX);
      expect(event.eventId).not.toBe('evt-1');
    });

    it('does not acknowledge when the rejection fails to publish', async () => {
      const rejecting = await rejectingConsumer('DURACAO_EXCEDIDA');
      publisher.setNextResult(false);
      const { ctx, ack, nack } = createContext();

      await expect(
        rejecting.handleVideoValidationRequested(createDto(), ctx),
      ).rejects.toThrow('Failed to publish VideoRejected');

      expect(ack).not.toHaveBeenCalled();
      expect(nack).toHaveBeenCalledWith({}, false, true);
    });

    it('publishes no second outcome when the job is redelivered', async () => {
      const rejecting = await rejectingConsumer('FORMATO_INVALIDO');
      const { ctx } = createContext();

      await rejecting.handleVideoValidationRequested(createDto(), ctx);
      await rejecting.handleVideoValidationRequested(createDto(), ctx);

      expect(publisher.published).toHaveLength(1);
    });
  });

  it('publishes VideoAccepted, and nothing else, when the validator accepts', async () => {
    const { ctx } = createContext();

    await consumer.handleVideoValidationRequested(createDto(), ctx);

    expect(publisher.publishedTypes).toEqual(['VideoAccepted']);
  });
});
