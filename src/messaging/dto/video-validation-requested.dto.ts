export class VideoValidationRequestedDto {
  eventId: string;
  processingRequestId: string;
  ownerUserId: string;
  sourceStorageKey: string;
  occurredAt: string;
  // The id the upstream chain assigned (OBS-31). Untrusted input: the consumer
  // parses it strictly and generates one when it is absent or invalid.
  correlationId?: string;
}
