# Worker Full Lifecycle Specification

## Problem Statement

The Worker reports only two of the five outcomes the lifecycle needs. It publishes `VideoAccepted` and `ProcessingCompleted`; it never publishes `VideoRejected`, `ProcessingStarted` or `ProcessingFailed`. The Catalog therefore cannot observe that work began, and can never learn that a video was rejected or that processing failed.

Adding those three events is blocked by how the publisher works today. `src/messaging/rabbitmq-event-publisher.ts` decides both the destination and the pattern by inspecting a field:

```ts
const client = 'zipStorageKey' in event ? this.processingCompletedClient : this.videoAcceptedClient;
```

With five event types this misroutes silently: `VideoRejected` and `ProcessingStarted` also lack `zipStorageKey`, so both would be published as `VideoAccepted`. The routing must become explicit before the vocabulary grows.

## Goals

- [ ] Publish every outcome the lifecycle defines, each to its own destination.
- [ ] Route events by declared identity rather than by field presence.
- [ ] Give validation a seam so real inspection can replace the permissive default without reopening this work.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| --- | --- |
| FFprobe, FFmpeg, frame extraction, ZIP creation, object storage | Owned by S4. This slice builds the seam those plug into. |
| The MP4/MOV, 500 MB and 10 minute rules | They are decisions of the real validator, which S4 introduces. |
| `prefetchCount`, FFmpeg thread count and autoscaling | Owned by S4 and recorded in AD-006. |
| Durable deduplication across replicas | Owned by S3. The in-memory checker stays as-is here. |
| Deciding request lifecycle state | The Catalog owns every transition; the Worker only reports outcomes. |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| How validation decides in this slice | Through a `VideoValidator` port whose default implementation accepts every input | It creates the seam S4 fills with FFprobe, and lets the rejection path be driven by a test double now instead of being faked. | y |
| Event routing | An explicit mapping from event type to destination and pattern | Structural discrimination is already wrong for three of the five events; widening it would guarantee a silent misroute. | y |
| Failure code vocabulary | `FORMATO_INVALIDO`, `DURACAO_EXCEDIDA`, `PROCESSAMENTO_FALHOU` | Fixed by `docs/foudation.md` and consumed by the Catalog. | y |
| When `ProcessingStarted` is published | Before any work begins, and before `ProcessingCompleted` or `ProcessingFailed` | It is what makes `PROCESSING` observable; publishing it afterwards would make the state meaningless. | y |
| A malformed message | Rejected at the transport layer, not reported as a business failure | A message missing `processingRequestId` names no request, so no outcome can be attributed to one. | y |
| Business retry | None. A terminal outcome is reported once | The foundation fixes one business attempt; a technical redelivery must not create a second. | y |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Route every event by its declared identity ⭐ MVP

**User Story**: As a maintainer, I want each event published to the destination its type names so that adding outcomes cannot silently misroute existing ones.

**Why P1**: Every other story in this slice publishes a new event type, and all of them are unsafe until this holds.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN the Worker publishes an event THEN it SHALL select the destination and the pattern from an explicit mapping keyed by the event type. <!-- event-driven -->
2. The publisher SHALL NOT infer an event's type from the presence or absence of any payload field. <!-- ubiquitous -->
3. IF an event type has no configured destination THEN the publisher SHALL fail loudly rather than fall back to a default destination. <!-- unwanted-behavior -->
4. WHEN publishing fails THEN the Worker SHALL NOT acknowledge the job that produced the event. <!-- event-driven -->

**Independent Test**: Publish one event of every supported type against a fake client and assert the destination and pattern recorded for each.

---

### P2: Report the outcome of validation

**User Story**: As the Catalog, I want to learn whether a submitted video was accepted or rejected so that a rejected video reaches `FAILED` instead of waiting forever.

**Why P2**: It is the first of the two paths that make `FAILED` reachable.

**Acceptance Criteria**:

1. WHEN the validator accepts a video THEN the Worker SHALL publish `VideoAccepted` carrying a freshly generated `eventId` and the `processingRequestId`. <!-- event-driven -->
2. WHEN the validator rejects a video THEN the Worker SHALL publish `VideoRejected` carrying the `failureCode` the validator reported. <!-- event-driven -->
3. WHEN the validator rejects a video THEN the Worker SHALL NOT publish `VideoAccepted` for that request. <!-- event-driven -->
4. IF a validation job is redelivered after its outcome was published THEN the Worker SHALL publish no second outcome. <!-- unwanted-behavior -->

**Independent Test**: Drive the consumer with a validator double that accepts, then one that rejects with each defined code, and assert the published event in each case.

---

### P3: Report the progress and outcome of processing

**User Story**: As the Catalog, I want to observe that processing started and how it ended so that `PROCESSING` is a real state and a failure becomes terminal.

**Why P3**: It completes the lifecycle, and depends on the routing P1 establishes.

**Acceptance Criteria**:

1. WHEN the Worker begins a processing job THEN it SHALL publish `ProcessingStarted` before performing any work. <!-- event-driven -->
2. WHEN processing succeeds THEN the Worker SHALL publish `ProcessingCompleted` carrying the `attemptId` and the deterministic `zipStorageKey`. <!-- event-driven -->
3. IF processing fails THEN the Worker SHALL publish `ProcessingFailed` carrying `PROCESSAMENTO_FALHOU` and the `attemptId`. <!-- unwanted-behavior -->
4. WHEN processing ends, whether it succeeded or failed, THEN the Worker SHALL have published exactly one of `ProcessingCompleted` or `ProcessingFailed`. <!-- event-driven -->
5. IF a processing job is redelivered after its outcome was published THEN the Worker SHALL create no second attempt and publish no second outcome. <!-- unwanted-behavior -->

**Independent Test**: Run a job to success and a job forced to fail, asserting the ordered sequence of published events in each case.

---

## Edge Cases

- IF a job message omits `processingRequestId` or `attemptId` THEN the Worker SHALL reject the message without publishing any outcome, because no outcome can be attributed to an unnamed request.
- IF `ProcessingStarted` publishes but the work then fails THEN `ProcessingFailed` SHALL still be published, so the request does not remain in `PROCESSING`.
- IF publishing `ProcessingStarted` fails THEN the Worker SHALL NOT begin the work, since the Catalog would never observe the state it is about to leave.
- WHEN the validator reports a code outside the defined vocabulary THEN the Worker SHALL treat it as a defect and SHALL NOT publish it.

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| LC-01 | P1: Explicit routing | Design | Pending |
| LC-02 | P1: Explicit routing | Design | Pending |
| LC-03 | P1: Explicit routing | Design | Pending |
| LC-04 | P1: Explicit routing | Design | Pending |
| LC-05 | P2: Validation outcome | Design | Pending |
| LC-06 | P2: Validation outcome | Design | Pending |
| LC-07 | P2: Validation outcome | Design | Pending |
| LC-08 | P2: Validation outcome | Design | Pending |
| LC-09 | P3: Processing outcome | Design | Pending |
| LC-10 | P3: Processing outcome | Design | Pending |
| LC-11 | P3: Processing outcome | Design | Pending |
| LC-12 | P3: Processing outcome | Design | Pending |
| LC-13 | P3: Processing outcome | Design | Pending |

**ID format:** `LC-[NUMBER]`

**Coverage:** 13 total, 0 mapped to tasks, 13 unmapped (mapping happens in Tasks).

---

## Success Criteria

- [ ] Each of the five event types reaches its own destination with its own pattern.
- [ ] A rejected video and a failed processing job each produce exactly one outcome event.
- [ ] `ProcessingStarted` always precedes the outcome of the same job.
- [ ] Replaying any job publishes nothing further.
