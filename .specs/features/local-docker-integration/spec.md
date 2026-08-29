# Worker Local Docker Integration Specification

## Problem Statement

Worker currently exercises validation through fakes only. It must consume real local RMQ messages, publish validation acceptance and a simulated completion, and preserve reliable acknowledgement behavior.

## Goals

- [ ] Consume validation and processing queues with manual acknowledgements.
- [ ] Emit documented local `VideoAccepted` and `ProcessingCompleted` JSON messages.
- [ ] Preserve duplicate and publisher-failure safety.

## Out of Scope

| Feature | Reason |
| --- | --- |
| FFprobe, FFmpeg, S3, ZIP creation, AWS | local completion is a transport/lifecycle simulation only. |
| Catalog transitions and Notification delivery | owned by other services. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- |
| Simulated result | `zipStorageKey` is deterministic from request ID | proves payload flow without binary work | y |
| Broker behavior | `noAck: false` and explicit ack after effect/publication | preserves redelivery semantics | y |

**Open questions:** none.

## User Stories

### P1: Process local queue events ⭐ MVP

**Acceptance Criteria**:

1. WHEN Worker receives valid `VideoValidationRequested`, THEN it SHALL publish `VideoAccepted` with a UUID v4 event ID different from the input and the same request ID. <!-- event-driven -->
2. WHEN Worker receives valid `ProcessingQueued`, THEN it SHALL publish `ProcessingCompleted` with a new UUID v4 event ID, the same request ID, attempt ID, deterministic non-empty ZIP key, and occurred time. <!-- event-driven -->
3. WHEN either effect and required publication succeed, THEN Worker SHALL acknowledge the source RabbitMQ message. <!-- event-driven -->
4. IF a required request ID is missing or a follow-up publish fails, THEN Worker SHALL reject/surface the failure and SHALL not acknowledge success. <!-- unwanted-behavior -->
5. WHEN a repeated event ID arrives, THEN Worker SHALL not publish a second accepted or completed event. <!-- event-driven -->

**Independent Test**: Run local RMQ integration tests for valid, duplicate, malformed, and forced publisher-failure messages.

### P2: Preserve Worker verification improvements

1. WHEN tests assert generated event IDs, THEN they SHALL assert UUID v4 format and inequality from input IDs. <!-- event-driven -->
2. WHEN e2e forces publisher failure, THEN it SHALL assert the message is not treated as acknowledged. <!-- event-driven -->
3. The Worker SHALL retain AppleDouble exclusions without runtime change. <!-- ubiquitous -->

## Edge Cases

- IF RabbitMQ is unavailable, THEN Worker readiness SHALL be false.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WRK-01 | P1 | Design | Implementing |
| WRK-02 | P1 | Design | Implementing |
| WRK-03 | P1 | Design | Implementing |
| WRK-04 | P1 | Design | Implementing |
| WRK-05 | P1 | Design | Implementing |
| WRK-06 | P2 | Design | Implementing |
| WRK-07 | P2 | Design | Pending |
| WRK-08 | P2 | Design | Pending |

## Success Criteria

- [ ] Worker emits exactly the two local event types over RabbitMQ with safe acknowledgement behavior.
