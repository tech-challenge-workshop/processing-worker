# Worker Initial Vertical Slice Specification

## Problem Statement

The Worker must prove that it can consume the Catalog's validation message and return a controlled result. Media validation and processing are deferred so the first integration slice remains focused on asynchronous communication.

## Goals

- [ ] Consume documented `VideoValidationRequested` JSON.
- [ ] Publish a controlled `VideoAccepted` outcome for valid input.

## Out of Scope

| Feature | Reason |
| --- | --- |
| FFprobe and FFmpeg | Added in the media validation and processing slices. |
| S3 reads, ZIP creation, and storage | Added in the processing slice. |
| Processing Request state changes | Owned by Processing Catalog. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Successful validation | Valid controlled input is accepted. | The first slice proves message flow, not file inspection. | Yes |
| Message shape | Stable JSON documented in `docs/foudation.md`. | The MVP uses no shared contracts package. | Yes |

**Open questions:** none - all resolved or logged above.

## User Stories

### P1: Consume and accept validation request

**User Story**: As a developer, I want the Worker to consume one validation request and publish an accepted result so that the Catalog can progress the controlled flow.

**Why P1**: It proves the first RabbitMQ consumer/producer path before media tooling.

**Acceptance Criteria**:

1. WHEN the Worker receives `VideoValidationRequested` with `eventId`, `processingRequestId`, `ownerUserId`, `sourceStorageKey`, and `occurredAt` THEN it SHALL publish `VideoAccepted` with a new `eventId`, the same `processingRequestId`, and `occurredAt`.
2. IF `processingRequestId` is absent from a validation message THEN the Worker SHALL reject the message and SHALL not publish `VideoAccepted`.
3. IF the same validation `eventId` is delivered again THEN the Worker SHALL not publish another `VideoAccepted` event.
4. The Worker SHALL not invoke FFprobe, FFmpeg, S3, or ZIP creation in this slice.

**Independent Test**: Deliver valid, invalid, and duplicate messages to the Worker consumer and assert published outcomes.

## Edge Cases

- IF publishing `VideoAccepted` fails THEN the Worker SHALL leave the input message unacknowledged for technical redelivery.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WRK-01 | P1: Consume and accept validation request | Tasks | Pending |
| WRK-02 | P1: Consume and accept validation request | Tasks | Pending |
| WRK-03 | P1: Consume and accept validation request | Tasks | Pending |
| WRK-04 | P1: Consume and accept validation request | Tasks | Pending |

**Coverage:** 4 total, 4 mapped to future tasks, 0 unmapped.

## Success Criteria

- [ ] One valid validation message produces one accepted event with the same request ID.
- [ ] Invalid and duplicate messages produce no duplicate outcome.
