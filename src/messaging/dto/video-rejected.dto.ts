import { FailureCode } from '../../validation/video-validator.interface';

export class VideoRejectedDto {
  eventId: string;
  processingRequestId: string;
  failureCode: FailureCode;
  occurredAt: string;
  // The consumed message's id, republished so the chain stays unbroken
  // (OBS-32/33). Optional: absent until the publisher sets it from context.
  correlationId?: string;
}
