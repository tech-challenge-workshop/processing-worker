import { Controller, Inject, Injectable } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { DuplicateChecker } from './duplicate-checker.interface';
import type { EventPublisher } from '../messaging/event-publisher.interface';
import { outcomeEventId } from '../messaging/outcome-event-id';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { VideoAcceptedDto } from '../messaging/dto/video-accepted.dto';
import { VideoRejectedDto } from '../messaging/dto/video-rejected.dto';
import type { VideoValidator } from './video-validator.interface';

export class ValidationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationRejectedError';
  }
}

@Injectable()
@Controller()
export class ValidationConsumer {
  constructor(
    @Inject('DUPLICATE_CHECKER')
    private readonly duplicateChecker: DuplicateChecker,
    @Inject('EVENT_PUBLISHER')
    private readonly eventPublisher: EventPublisher,
    @Inject('VIDEO_VALIDATOR')
    private readonly validator: VideoValidator,
  ) {}

  @EventPattern('VideoValidationRequested')
  async handleVideoValidationRequested(
    @Payload() dto: VideoValidationRequestedDto,
    @Ctx() ctx?: RmqContext,
  ): Promise<void> {
    try {
      await this.processVideoValidationRequested(dto);
      if (ctx) {
        const channel = ctx.getChannelRef() as {
          ack: (message: unknown) => void;
          nack: (
            message: unknown,
            allUpTo?: boolean,
            requeue?: boolean,
          ) => void;
        };
        channel.ack(ctx.getMessage());
      }
    } catch (err) {
      if (ctx) {
        const channel = ctx.getChannelRef() as {
          ack: (message: unknown) => void;
          nack: (
            message: unknown,
            allUpTo?: boolean,
            requeue?: boolean,
          ) => void;
        };
        const requeue = !(err instanceof ValidationRejectedError);
        channel.nack(ctx.getMessage(), false, requeue);
      }
      throw err;
    }
  }

  private async processVideoValidationRequested(
    dto: VideoValidationRequestedDto,
  ): Promise<void> {
    if (!dto.processingRequestId) {
      throw new ValidationRejectedError(
        'processingRequestId is required in VideoValidationRequested',
      );
    }

    const isDuplicate = await this.duplicateChecker.isDuplicate(dto.eventId);
    if (isDuplicate) {
      return;
    }

    const outcome = await this.validator.validate(dto);

    if (outcome.accepted) {
      const accepted: VideoAcceptedDto = {
        eventId: outcomeEventId(dto.eventId, 'VideoAccepted'),
        processingRequestId: dto.processingRequestId,
        occurredAt: dto.occurredAt,
      };

      const published = await this.eventPublisher.publish(
        'VideoAccepted',
        accepted,
      );
      if (!published) {
        throw new Error('Failed to publish VideoAccepted');
      }
    } else {
      const rejected: VideoRejectedDto = {
        eventId: outcomeEventId(dto.eventId, 'VideoRejected'),
        processingRequestId: dto.processingRequestId,
        failureCode: outcome.failureCode,
        occurredAt: dto.occurredAt,
      };

      const published = await this.eventPublisher.publish(
        'VideoRejected',
        rejected,
      );
      if (!published) {
        throw new Error('Failed to publish VideoRejected');
      }
    }

    await this.duplicateChecker.mark(dto.eventId);
  }
}
