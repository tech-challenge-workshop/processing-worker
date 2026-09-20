import { FailureCode } from '../../validation/video-validator.interface';

export class ProcessingFailedDto {
  eventId: string;
  processingRequestId: string;
  attemptId: string;
  failureCode: FailureCode;
  occurredAt: string;
}
