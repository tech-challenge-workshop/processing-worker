export class ProcessingQueuedDto {
  eventId: string;
  processingRequestId: string;
  ownerUserId: string;
  sourceStorageKey: string;
  attemptId: string;
  occurredAt: string;
}
