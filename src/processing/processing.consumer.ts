import { Controller, Inject, Injectable } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import type { EventPublisher } from '../messaging/event-publisher.interface';
import { ProcessingCompletedDto } from '../messaging/dto/processing-completed.dto';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import type { DuplicateChecker } from '../validation/duplicate-checker.interface';

export class ProcessingRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingRejectedError';
  }
}

@Injectable()
@Controller()
export class ProcessingConsumer {
  constructor(
    @Inject('DUPLICATE_CHECKER')
    private readonly duplicateChecker: DuplicateChecker,
    @Inject('EVENT_PUBLISHER')
    private readonly eventPublisher: EventPublisher,
  ) {}

  @EventPattern('ProcessingQueued')
  async handleProcessingQueued(
    @Payload() dto: ProcessingQueuedDto,
    @Ctx() ctx?: RmqContext,
  ): Promise<void> {
    try {
      await this.processProcessingQueued(dto);
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
        const requeue = !(err instanceof ProcessingRejectedError);
        channel.nack(ctx.getMessage(), false, requeue);
      }
      throw err;
    }
  }

  private async processProcessingQueued(
    dto: ProcessingQueuedDto,
  ): Promise<void> {
    if (!dto.processingRequestId || !dto.attemptId) {
      throw new ProcessingRejectedError(
        'processingRequestId and attemptId are required in ProcessingQueued',
      );
    }

    const isDuplicate = await this.duplicateChecker.isDuplicate(dto.eventId);
    if (isDuplicate) {
      return;
    }

    const completed: ProcessingCompletedDto = {
      eventId: randomUUID(),
      processingRequestId: dto.processingRequestId,
      attemptId: dto.attemptId,
      zipStorageKey: `local/${dto.processingRequestId}/${dto.attemptId}/frames.zip`,
      occurredAt: new Date().toISOString(),
    };

    const published = await this.eventPublisher.publish(completed);
    if (!published) {
      throw new Error('Failed to publish ProcessingCompleted');
    }

    await this.duplicateChecker.mark(dto.eventId);
  }
}
