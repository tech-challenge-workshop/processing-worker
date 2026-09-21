import { FailureCode } from '../../validation/video-validator.interface';

export class VideoRejectedDto {
  eventId: string;
  processingRequestId: string;
  failureCode: FailureCode;
  occurredAt: string;
}
