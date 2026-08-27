import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { DuplicateChecker } from './duplicate-checker.interface';
import type { EventPublisher } from '../messaging/event-publisher.interface';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { VideoAcceptedDto } from '../messaging/dto/video-accepted.dto';

export class ValidationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationRejectedError';
  }
}

@Injectable()
export class ValidationConsumer {
  constructor(
    private readonly duplicateChecker: DuplicateChecker,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async handleVideoValidationRequested(
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

    const accepted: VideoAcceptedDto = {
      eventId: randomUUID(),
      processingRequestId: dto.processingRequestId,
      occurredAt: dto.occurredAt,
    };

    const published = await this.eventPublisher.publish(accepted);
    if (!published) {
      throw new Error('Failed to publish VideoAccepted');
    }

    await this.duplicateChecker.mark(dto.eventId);
  }
}
