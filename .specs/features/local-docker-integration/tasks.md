# Worker Local Docker Integration Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/.specs/features/local-docker-integration/design.md`
**Spec**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/.specs/features/local-docker-integration/spec.md`
**Root contract**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/docs/foudation.md`
**Sibling specs**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-catalog/.specs/features/local-docker-integration/spec.md`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/fiap-x-api/.specs/features/local-docker-integration/spec.md`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/notification-service/.specs/features/local-docker-integration/spec.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/package.json` test/lint/build scripts; no additional coverage thresholds configured.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Domain / service logic | unit | All branches; 1:1 to spec ACs; all listed edge cases | `src/**/*.spec.ts` | `npm test` |
| Module wiring / broker port | e2e | Consumer wires correctly with fake broker context; happy path + duplicate + malformed + publish-failure edges | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Entity / DTO / config | none | Build gate only | `src/**/*.dto.ts`, `src/**/*.interface.ts` | build gate only |
| Container image | build | `docker build .` succeeds and health endpoint responds when broker is available | `Dockerfile` | `docker build .` |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npm test` |
| Full | After tasks with e2e/integration tests | `npm test && npm run test:e2e` |
| Build | After phase completion or config/entity-only tasks | `npm run build && npm run lint && npm test && npm run test:e2e` |
| Image | After Dockerfile change | `docker build . -t processing-worker:local` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order.

### Phase 1: Infrastructure & Contracts

Builds the container image, RabbitMQ transport module, processing DTOs, and the real publisher interface.

```
T1
T2 → T4
T3 → T4
```

### Phase 2: Consumers

Wires manual acknowledgement into the existing validation consumer and adds the new processing consumer.

```
T2 → T5
T4 → T5
T4 → T6
T3 → T6
T2 → T6
```

### Phase 3: Quality & Verification

Closes the verifier gaps from the first slice and proves the integration behavior end-to-end.

```
T5 → T7
T6 → T7
T5 → T8
T6 → T8
T9 independent
```

**Dependency rationale**: T1 (Dockerfile) is independent packaging. T2 (transport/health) must exist before T4 (publisher uses transport) and T5/T6 (consumers use transport). T3 (DTOs) must exist before T4 and T6. T4 must exist before T5 and T6. T5 and T6 must exist before T7 (UUID assertions depend on consumer output) and T8 (e2e needs both consumers). T9 (AppleDouble exclusions) is a static hygiene check.

---

## Task Breakdown

### T1: Add Worker Dockerfile

**What**: Create a production-oriented Dockerfile that builds the Worker NestJS application and runs `node dist/main` on port `3002`.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/Dockerfile`
**Depends on**: None
**Reuses**: `package.json` scripts (`npm run build`, `npm ci`)
**Requirement**: WRK-01 ( readiness to participate in local flow)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Dockerfile uses a Node 22 Alpine base image and multi-stage or single-stage build.
- [x] Dockerfile exposes port `3002` and sets `NODE_ENV=production`.
- [x] Image builds successfully: `docker build . -t processing-worker:local`
- [x] Image does not contain AWS credentials, `.env`, or runtime secrets.

**Tests**: image build
**Gate**: image

---

### T2: Add RabbitMQ transport module and health endpoint

**What**: Add `MessagingModule` that configures `@nestjs/microservices` RabbitMQ transport with `noAck: false`, and a `HealthController` that reports readiness based on broker availability.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/messaging/messaging.module.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/health/health.controller.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/health/health.module.ts`
**Depends on**: None
**Reuses**: NestJS `ClientsModule.registerAsync` or hybrid `connectMicroservice` pattern; `src/app.module.ts`
**Requirement**: WRK-03, WRK-04, Worker edge case (RabbitMQ unavailable -> readiness false)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `MessagingModule` registers a RabbitMQ client using environment variables `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`, `RABBITMQ_VIDEO_VALIDATION_QUEUE`, and `RABBITMQ_PROCESSING_QUEUE`.
- [x] Transport configuration uses `noAck: false` so consumers must acknowledge manually.
- [x] `GET /health` returns `200 { status: 'ok', rabbitmq: true }` when connected and `503 { status: 'error', rabbitmq: false }` when not.
- [x] Build gate passes: `npm run build && npm run lint`

**Tests**: none
**Gate**: build

---

### T3: Add processing DTOs

**What**: Define local DTOs for `ProcessingQueued` and `ProcessingCompleted` events with the documented JSON fields from `/Volumes/HIKSEMI/repository/fiap-x/fiapx/docs/foudation.md`.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/messaging/dto/processing-queued.dto.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/messaging/dto/processing-completed.dto.ts`
**Depends on**: None
**Reuses**: NestJS class declaration patterns from existing `src/messaging/dto/` files
**Requirement**: WRK-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ProcessingQueuedDto` contains `eventId`, `processingRequestId`, `ownerUserId`, `sourceStorageKey`, `attemptId`, `occurredAt`.
- [x] `ProcessingCompletedDto` contains `eventId`, `processingRequestId`, `attemptId`, `zipStorageKey`, `occurredAt`.
- [x] Types are exported and TypeScript compiles.
- [x] Build gate passes: `npm run build`

**Tests**: none
**Gate**: build

---

### T4: Extend EventPublisher and add RabbitMQ publisher

**What**: Extend `EventPublisher` to publish both `VideoAccepted` and `ProcessingCompleted` events, and implement `RabbitmqEventPublisher` that emits JSON to the configured exchange/routing keys and returns a boolean promise.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/messaging/event-publisher.interface.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/messaging/rabbitmq-event-publisher.ts`
**Depends on**: T2, T3
**Reuses**: `VideoAcceptedDto` from initial slice; new `ProcessingCompletedDto`
**Requirement**: WRK-01, WRK-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `EventPublisher` interface accepts `VideoAcceptedDto | ProcessingCompletedDto`.
- [x] `RabbitmqEventPublisher` implements the interface and sends JSON to RabbitMQ using the client from `MessagingModule`.
- [x] `publish` resolves to `true` when the broker accepts the message and `false`/throws on failure.
- [x] Unit tests for `RabbitmqEventPublisher` pass using a fake RabbitMQ client: `npm test -- rabbitmq-event-publisher`.
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T5: Add manual acknowledgement to ValidationConsumer

**What**: Wrap `ValidationConsumer.handleVideoValidationRequested` with an RMQ-aware handler that calls `ack` only when the follow-up `VideoAccepted` publish succeeds and `nack` (requeue=true) when publication fails. Reject malformed messages with `nack` (requeue=false).
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/validation/validation.consumer.ts`
**Depends on**: T2, T4
**Reuses**: Existing `ValidationConsumer` domain logic; `RmqContext` from `@nestjs/microservices`
**Requirement**: WRK-01, WRK-03, WRK-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Valid message publishes `VideoAccepted` with a UUID v4 `eventId` different from the source `eventId`, same `processingRequestId`, and same `occurredAt`, then `ack`s.
- [x] Missing `processingRequestId` results in `ValidationRejectedError` and `nack(false)`.
- [x] Duplicate source `eventId` `ack`s without publishing.
- [x] Publisher failure throws and results in `nack(true)` (no successful ack).
- [x] Unit tests pass: `npm test -- validation.consumer`
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T6: Create ProcessingConsumer with simulation and manual acknowledgement

**What**: Implement `ProcessingConsumer.handleProcessingQueued` that validates required fields, deduplicates by source `eventId`, simulates `zipStorageKey = local/{processingRequestId}/{attemptId}/frames.zip`, publishes `ProcessingCompleted`, and acknowledges only after successful publication.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/processing/processing.consumer.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/processing/processing.module.ts`
**Depends on**: T2, T3, T4
**Reuses**: `DuplicateChecker`, `EventPublisher`, `ProcessingQueuedDto`, `ProcessingCompletedDto`
**Requirement**: WRK-02, WRK-03, WRK-04, WRK-05

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Valid `ProcessingQueued` publishes `ProcessingCompleted` with a UUID v4 `eventId` different from the source `eventId`, same `processingRequestId` and `attemptId`, deterministic `zipStorageKey`, and `occurredAt`.
- [ ] Missing `processingRequestId` or `attemptId` throws domain error and `nack(false)`.
- [ ] Duplicate source `eventId` `ack`s without publishing.
- [ ] Publisher failure throws and results in `nack(true)` (no successful ack).
- [ ] Unit tests pass: `npm test -- processing.consumer`
- [ ] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T7: Strengthen generated-event assertions to UUID v4

**What**: Update unit and e2e tests that assert generated event IDs so they validate UUID v4 format and inequality from the input `eventId`, per the first-slice verifier gap.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/validation/validation.consumer.spec.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/src/processing/processing.consumer.spec.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/test/validation.e2e-spec.ts`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/test/processing.e2e-spec.ts`
**Depends on**: T5, T6
**Reuses**: Existing test fixtures; `randomUUID`-shaped UUID v4 regex
**Requirement**: WRK-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Every generated `eventId` assertion checks it is not equal to the source `eventId`.
- [ ] Every generated `eventId` assertion checks it matches UUID v4 format.
- [ ] No existing test weakens its assertions.
- [ ] Full gate passes: `npm test && npm run test:e2e`

**Tests**: unit + e2e
**Gate**: full

---

### T8: Add RMQ e2e integration test for both consumers

**What**: Add an e2e test that boots `AppModule` with fake publisher and duplicate checker, invokes both RMQ-wrapped consumers with valid, duplicate, malformed, and publisher-failure inputs, and asserts published events plus ack/nack behavior.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/test/local-docker-integration.e2e-spec.ts`
**Depends on**: T5, T6
**Reuses**: `Test.createTestingModule` pattern from `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/test/app.e2e-spec.ts`
**Requirement**: WRK-01, WRK-02, WRK-03, WRK-04, WRK-05, WRK-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Valid `VideoValidationRequested` produces one `VideoAccepted` and one `ack`.
- [ ] Valid `ProcessingQueued` produces one `ProcessingCompleted` with deterministic ZIP key and one `ack`.
- [ ] Duplicate event IDs produce no second event and still `ack`.
- [ ] Malformed input (missing required field) results in `nack(false)` and no success event.
- [ ] Forced publisher failure results in `nack(true)` and no successful acknowledgement.
- [ ] Full gate passes: `npm test && npm run test:e2e`

**Tests**: e2e
**Gate**: full

---

### T9: Verify AppleDouble exclusions are preserved

**What**: Confirm `.gitignore`, Jest `testPathIgnorePatterns`, and lint/prettier ignore rules exclude `._*` AppleDouble files without changing runtime behavior.
**Where**: `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/.gitignore`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/package.json`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/.prettierrc`, `/Volumes/HIKSEMI/repository/fiap-x/fiapx/processing-worker/eslint.config.mjs`
**Depends on**: None
**Reuses**: Existing ignore rules from initial slice
**Requirement**: WRK-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `.gitignore` excludes `._*` files.
- [ ] `package.json` Jest `testPathIgnorePatterns` excludes `\._` or equivalent.
- [ ] `npm run lint` and `npm run format --check` (if available) pass without touching `._*` files.
- [ ] Build gate passes: `npm run build && npm run lint`

**Tests**: none
**Gate**: build

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3

Phase 1:  T1
Phase 1:  T2 → T4
Phase 1:  T3 → T4
Phase 2:  T2 → T5
Phase 2:  T4 → T5
Phase 2:  T2 → T6
Phase 2:  T4 → T6
Phase 2:  T3 → T6
Phase 3:  T5 → T7
Phase 3:  T6 → T7
Phase 3:  T5 → T8
Phase 3:  T6 → T8
Phase 3:  T9
```

Execution is strictly sequential by phase. Within a phase tasks may be parallelized when no dependency edge exists, but a single agent working one task at a time is acceptable.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Add Worker Dockerfile | 1 Dockerfile | ✅ Granular |
| T2: Add RabbitMQ transport module and health endpoint | 1 module + 1 controller | ✅ Granular |
| T3: Add processing DTOs | 2 DTO files | ✅ Granular |
| T4: Extend EventPublisher and add RabbitMQ publisher | 1 interface update + 1 implementation + unit tests | ✅ Granular |
| T5: Add manual acknowledgement to ValidationConsumer | 1 consumer update + unit tests | ✅ Granular |
| T6: Create ProcessingConsumer | 1 consumer + 1 module + unit tests | ✅ Granular |
| T7: Strengthen generated-event assertions | test-only changes across unit/e2e specs | ✅ Granular |
| T8: Add RMQ e2e integration test | 1 e2e spec | ✅ Granular |
| T9: Verify AppleDouble exclusions | static hygiene check | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | No incoming arrow | ✅ Match |
| T2 | None | No incoming arrow | ✅ Match |
| T3 | None | No incoming arrow | ✅ Match |
| T4 | T2, T3 | Arrows from T2 and T3 to T4 | ✅ Match |
| T5 | T2, T4 | Arrows from T2 and T4 to T5 | ✅ Match |
| T6 | T2, T3, T4 | Arrows from T2, T3, T4 to T6 | ✅ Match |
| T7 | T5, T6 | Arrows from T5 and T6 to T7 | ✅ Match |
| T8 | T5, T6 | Arrows from T5 and T6 to T8 | ✅ Match |
| T9 | None | No incoming arrow | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Container image | image build | image build | ✅ OK |
| T2 | Entity / config / module | build gate only | build | ✅ OK |
| T3 | Entity / DTO | build gate only | build | ✅ OK |
| T4 | Domain / service logic (port) | unit | unit | ✅ OK |
| T5 | Domain / service logic (consumer) | unit | unit | ✅ OK |
| T6 | Domain / service logic (consumer) | unit | unit | ✅ OK |
| T7 | Domain / service logic tests | unit + e2e | unit + e2e | ✅ OK |
| T8 | Module wiring / broker port | e2e | e2e | ✅ OK |
| T9 | Repository hygiene | build gate only | build | ✅ OK |

---

## Requirement Traceability Cross-Check

> Map every spec requirement ID to at least one task and verify no task is orphaned.

| Requirement ID | Spec AC | Covered By | Status |
| -------------- | ------- | ---------- | ------ |
| WRK-01 | P1 AC1: VideoValidationRequested -> VideoAccepted | T5 | ✅ Mapped |
| WRK-02 | P1 AC2: ProcessingQueued -> ProcessingCompleted | T3, T6 | ✅ Mapped |
| WRK-03 | P1 AC3: ack after successful effect/publication | T5, T6 | ✅ Mapped |
| WRK-04 | P1 AC4: missing field or publish failure -> no success ack | T5, T6, T8 | ✅ Mapped |
| WRK-05 | P1 AC5: duplicate eventId -> no second event | T5, T6, T8 | ✅ Mapped |
| WRK-06 | P2 AC1: UUID v4 assertions in tests | T7 | ✅ Mapped |
| WRK-07 | P2 AC2: e2e publisher failure without acknowledgement | T8 | ✅ Mapped |
| WRK-08 | P2 AC3: retain AppleDouble exclusions | T9 | ✅ Mapped |
