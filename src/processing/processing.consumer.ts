import { Controller, Inject, Injectable, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { EventPublisher } from '../messaging/event-publisher.interface';
import { outcomeEventId } from '../messaging/outcome-event-id';
import {
  MessageRejectedError,
  settleFailedMessage,
} from '../messaging/settle-failed-message';
import { withMessageCorrelation } from '../messaging/with-correlation';
import {
  type ProcessingOutcome,
  workerMetrics,
} from '../observability/metrics';
import { ProcessingCompletedDto } from '../messaging/dto/processing-completed.dto';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { ProcessingStartedDto } from '../messaging/dto/processing-started.dto';
import { ProcessingFailedDto } from '../messaging/dto/processing-failed.dto';
import type { FramePackager } from './frame-packager.interface';
import type { DuplicateChecker } from '../validation/duplicate-checker.interface';
import { ShutdownSignal } from './shutdown-signal';

export class ProcessingRejectedError extends MessageRejectedError {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingRejectedError';
  }
}

@Injectable()
@Controller()
export class ProcessingConsumer {
  private readonly logger = new Logger(ProcessingConsumer.name);

  constructor(
    @Inject('DUPLICATE_CHECKER')
    private readonly duplicateChecker: DuplicateChecker,
    @Inject('EVENT_PUBLISHER')
    private readonly eventPublisher: EventPublisher,
    @Inject('FRAME_PACKAGER')
    private readonly framePackager: FramePackager,
    private readonly shutdownSignal: ShutdownSignal,
  ) {}

  @EventPattern('ProcessingQueued')
  async handleProcessingQueued(
    @Payload() dto: ProcessingQueuedDto,
    @Ctx() ctx?: RmqContext,
  ): Promise<void> {
    // The whole handling runs in the message's correlation scope (OBS-31),
    // whatever the settlement: ack, nack, or left for redelivery on shutdown.
    // The scope closes when the handler settles. The job counts as in flight
    // on the processing queue until then, on every path (OBS-40).
    return withMessageCorrelation(dto, () =>
      workerMetrics.inflight('processing').track(() => this.handle(dto, ctx)),
    );
  }

  private async handle(
    dto: ProcessingQueuedDto,
    ctx?: RmqContext,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();
    try {
      const outcome = await this.processProcessingQueued(dto);
      if (outcome === 'left-for-redelivery') {
        return;
      }
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
      // Counted with its duration once the outcome is published and the
      // message acked (OBS-39). A duplicate, a job left for redelivery and a
      // retried failed publication are not outcomes.
      if (outcome !== 'duplicate') {
        const elapsedSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        workerMetrics.recordProcessing(outcome, elapsedSeconds);
      }
    } catch (err) {
      if (ctx) {
        const channel = ctx.getChannelRef() as {
          nack: (
            message: unknown,
            allUpTo?: boolean,
            requeue?: boolean,
          ) => void;
        };
        await settleFailedMessage(channel, ctx.getMessage(), err);
      }
      throw err;
    }
  }

  // 'left-for-redelivery': the app began shutting down while the job ran. No
  // terminal event is published and the message is neither acked nor nacked,
  // so the broker redelivers it once this connection is gone (MSG-14).
  private async processProcessingQueued(
    dto: ProcessingQueuedDto,
  ): Promise<ProcessingOutcome | 'duplicate' | 'left-for-redelivery'> {
    if (!dto.processingRequestId || !dto.attemptId) {
      throw new ProcessingRejectedError(
        'processingRequestId and attemptId are required in ProcessingQueued',
      );
    }

    const isDuplicate = await this.duplicateChecker.isDuplicate(dto.eventId);
    if (isDuplicate) {
      return 'duplicate';
    }

    const started: ProcessingStartedDto = {
      eventId: outcomeEventId(dto.eventId, 'ProcessingStarted'),
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

    let packaged: { zipStorageKey: string } | undefined;
    try {
      packaged = { zipStorageKey: await this.framePackager.packageFrames(dto) };
    } catch {
      packaged = undefined;
    }

    if (this.shutdownSignal.isClosing) {
      this.logger.warn(
        `Shutdown began while ${dto.processingRequestId} was processing; leaving the message unacked for redelivery`,
      );
      return 'left-for-redelivery';
    }

    if (!packaged) {
      const failed: ProcessingFailedDto = {
        eventId: outcomeEventId(dto.eventId, 'ProcessingFailed'),
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
      return 'failed';
    }

    const completed: ProcessingCompletedDto = {
      eventId: outcomeEventId(dto.eventId, 'ProcessingCompleted'),
      processingRequestId: dto.processingRequestId,
      attemptId: dto.attemptId,
      zipStorageKey: packaged.zipStorageKey,
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
    return 'completed';
  }
}
