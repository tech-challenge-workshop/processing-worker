# Catalog Messaging Hardening Specification — worker

## Problem Statement

The S4 Verifier passed the Worker with four follow-ups (V19):

- The health e2e suite depends on a clean shell: storage credentials set in the environment change its outcome.
- The spec never fixes which code a long video in an unsupported container gets, duration or format.
- Nothing proves that stopping the app while a job is in flight never acks it.
- Two broker behaviours have been checked only by hand: messages beyond the prefetch stay `ready`, and a non-JSON message is dead-lettered.

## Goals

- [ ] The Worker's test suite gives the same result in any shell
- [ ] The remaining Worker behaviours are pinned by tests, including against a real RabbitMQ

## Out of Scope

| Feature | Reason |
| --- | --- |
| Changing validation or processing behaviour | These are follow-ups on tested behaviour, not changes to it |
| The platform smoke | The broker checks are proven in the Worker's own suite (context.md, Agent's discretion) |

---

## Assumptions & Open Questions

Decisions of 2026-09-26 are in `processing-catalog/.specs/features/catalog-messaging-hardening/context.md`.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Duration or format first (RM-07 AC2/AC4) | A video longer than the limit is `DURACAO_EXCEDIDA` even when its container is not MP4/MOV, as the code does today | `ffprobe-video-validator.ts` checks duration first on purpose ("the more informative rejection"); this pins it | y |
| Where the broker checks run | A new e2e suite against a real RabbitMQ at `RABBITMQ_TEST_URL`; it fails instead of skipping when `CI` is set, and CI starts a RabbitMQ 4 service | Same pattern as the API's `STORAGE_TEST_ENDPOINT` (S6) | y |
| Health suite isolation | Save, clear and restore the storage variables around the suite | The pattern `test/composition.e2e-spec.ts:40-47` already uses | y |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: The suite is independent of the shell ⭐ MVP

**User Story**: As a developer, I want `npm run test:e2e` to give the same result whatever storage variables my shell holds.

**Why P1**: A test that passes or fails depending on the shell cannot be trusted.

**Acceptance Criteria**:

1. WHEN the health e2e suite runs with the storage variables set to any values THEN its results SHALL equal those with them unset.
2. WHEN the suite ends THEN the variables SHALL be restored to their prior values.

**Independent Test**: Run the suite with `STORAGE_ENDPOINT=http://127.0.0.1:9` exported: same result as without it.

---

### P2: Validation precedence is pinned

**User Story**: As a maintainer, I want the code a long unsupported video gets fixed by a test, so that reordering the checks is a visible decision.

**Why P2**: RM-07's precedence was never pinned.

**Acceptance Criteria**:

1. WHEN a probe reports a duration over the limit and a container outside MP4/MOV THEN the validator SHALL return `DURACAO_EXCEDIDA`.
2. WHEN a probe reports a duration within the limit and a container outside MP4/MOV THEN the validator SHALL return `FORMATO_INVALIDO`.

**Independent Test**: Swapping the two checks in the validator fails the first test.

---

### P3: Shutdown never acks unfinished work ⭐ MVP

**User Story**: As the operator, I want a Worker stopped mid-job to leave the message unacked, so that the broker gives it to another Worker.

**Why P3**: A job acked but never finished would leave its request stuck.

**Acceptance Criteria**:

1. WHEN the app is closed while the frame packager is still running THEN the processing message SHALL NOT be acked.
2. WHEN the app is closed while the packager is running THEN no `ProcessingCompleted` and no `ProcessingFailed` SHALL be published.

**Independent Test**: Hold the packager on a promise, close the app, then release it: no ack, no terminal event.

---

### P4: Broker behaviours proven against RabbitMQ

**User Story**: As the operator, I want the prefetch bound and the dead-lettering of malformed messages proven against a real broker.

**Why P4**: Both were checked only by hand (V19).

**Acceptance Criteria**:

1. WHEN more processing messages are queued than the processing prefetch THEN the messages beyond the prefetch SHALL stay `ready` while the first are in flight.
2. WHEN a non-JSON message is published to the validation queue THEN the Worker SHALL reject it without requeue, and it SHALL reach `video-validation.dlq` on its first delivery.
3. IF `RABBITMQ_TEST_URL` is unset while `CI` is set THEN the suite SHALL fail rather than skip.

**Independent Test**: With prefetch 1 and three queued messages held in flight, the queue reports 2 ready and 1 unacked.

---

## Edge Cases

- WHEN the broker suite runs THEN it SHALL declare its queues with the platform's names and policy arguments, or skip declaring them when the broker already has them.

---

## Requirement Traceability

`MSG-` is shared: `processing-catalog` owns `MSG-01` to `MSG-09`, `notification-service` `MSG-10` and `MSG-11`, this service `MSG-12` to `MSG-15`.

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| MSG-12 | P1: Health suite isolated from the shell (V19.1) | Tasks | In Tasks |
| MSG-13 | P2: Duration-over-format precedence pinned (V19.2) | Tasks | In Tasks |
| MSG-14 | P3: Shutdown never acks in-flight work (V19.3) | Tasks | In Tasks |
| MSG-15 | P4: Prefetch and non-JSON DLQ against RabbitMQ (V19.4) | Tasks | In Tasks |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 4 total, 4 mapped to tasks, 0 unmapped

---

## Success Criteria

- [ ] The e2e suite's result does not depend on the shell
- [ ] The four V19 follow-ups each have a test that fails when the behaviour is removed

---

## Dependencies

None.
