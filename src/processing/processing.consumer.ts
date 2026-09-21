import { Controller, Inject, Injectable } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import type { EventPublisher } from '../messaging/event-publisher.interface';
import { ProcessingCompletedDto } from '../messaging/dto/processing-completed.dto';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { ProcessingStartedDto } from '../messaging/dto/processing-started.dto';
import { ProcessingFailedDto } from '../messaging/dto/processing-failed.dto';
import type { FramePackager } from './frame-packager.interface';
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
    @Inject('FRAME_PACKAGER')
    private readonly framePackager: FramePackager,
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

    const started: ProcessingStartedDto = {
      eventId: randomUUID(),
      processingRequestId: dto.processingRequestId,
      attemptId: dto.attemptId,
      occurredAt: new Date().toISOString(),
    };

    const startPublished = await this.eventPublisher.publish(
      'ProcessingStarted',
      started,
    );
    if (!startPublished) {
      // The work must not begin: the Catalog would never observe the state
      // the request is about to leave.
      throw new Error('Failed to publish ProcessingStarted');
    }

    let zipStorageKey: string;
    try {
      zipStorageKey = await this.framePackager.packageFrames(dto);
    } catch {
      const failed: ProcessingFailedDto = {
        eventId: randomUUID(),
        processingRequestId: dto.processingRequestId,
        attemptId: dto.attemptId,
        failureCode: 'PROCESSAMENTO_FALHOU',
        occurredAt: new Date().toISOString(),
      };

      const failPublished = await this.eventPublisher.publish(
        'ProcessingFailed',
        failed,
      );
      if (!failPublished) {
        throw new Error('Failed to publish ProcessingFailed');
      }

      await this.duplicateChecker.mark(dto.eventId);
      return;
    }

    const completed: ProcessingCompletedDto = {
      eventId: randomUUID(),
      processingRequestId: dto.processingRequestId,
      attemptId: dto.attemptId,
      zipStorageKey,
      occurredAt: new Date().toISOString(),
    };

    const published = await this.eventPublisher.publish(
      'ProcessingCompleted',
      completed,
    );
    if (!published) {
      throw new Error('Failed to publish ProcessingCompleted');
    }

    await this.duplicateChecker.mark(dto.eventId);
  }
}
