# Worker Initial Vertical Slice Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/initial-vertical-slice/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `package.json` test/lint/build scripts; no additional coverage thresholds configured.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Domain / service logic | unit | All branches; 1:1 to spec ACs; all listed edge cases | `src/**/*.spec.ts` | `npm test` |
| Module wiring / broker port | e2e | Consumer wires correctly with fake broker; happy path + publish-failure edge | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Entity / DTO / config | none | Build gate only | `src/**/*.dto.ts`, `src/**/*.interface.ts` | build gate only |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npm test` |
| Full | After tasks with e2e/integration tests | `npm test && npm run test:e2e` |
| Build | After phase completion or config/entity-only tasks | `npm run build && npm run lint && npm test && npm run test:e2e` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order.

### Phase 1: Contracts and Ports

Tasks that establish local DTOs and broker abstractions first.

```
T1 → T2
T1 → T3
T2 → T4
T3 → T4
```

### Phase 2: Wiring and Verification

Wires the components into the Nest application and verifies them with tests and build gates.

```
T5 → T6 → T7
```

**Dependency rationale**: T2 (duplicate checker) and T3 (event publisher) both consume the DTOs from T1, and T4 needs both ports. T5 wires the consumer, T6 adds unit tests, T7 adds the e2e wiring test.

---

## Task Breakdown

### T1: Create local DTOs for validation and acceptance events

**What**: Define `VideoValidationRequestedDto` and `VideoAcceptedDto` classes with the documented JSON fields.
**Where**: `src/messaging/dto/video-validation-requested.dto.ts`, `src/messaging/dto/video-accepted.dto.ts`
**Depends on**: None
**Reuses**: NestJS class declaration patterns from generated source files
**Requirement**: WRK-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Both DTOs exist with the exact fields from the spec
- [x] Types are exported and TypeScript compiles
- [x] Build gate passes: `npm run build`

**Tests**: none
**Gate**: build

---

### T2: Create DuplicateChecker port and in-memory implementation

**What**: Define the `DuplicateChecker` interface and an in-memory implementation that tracks seen `eventId`s.
**Where**: `src/validation/duplicate-checker.interface.ts`, `src/validation/in-memory-duplicate-checker.ts`
**Depends on**: T1
**Reuses**: `VideoValidationRequestedDto.eventId` shape from T1
**Requirement**: WRK-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Interface exposes `isDuplicate(eventId: string): Promise<boolean>` and `mark(eventId: string): Promise<void>`
- [x] In-memory implementation returns `true` for repeated IDs and `false` for new IDs
- [x] Unit tests for the checker pass: `npm test -- in-memory-duplicate-checker`
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T3: Create EventPublisher port and in-memory fake

**What**: Define the `EventPublisher` interface and an in-memory fake that records published events, so tests can run without a real broker.
**Where**: `src/messaging/event-publisher.interface.ts`, `src/messaging/fake-event-publisher.ts`
**Depends on**: T1
**Reuses**: `VideoAcceptedDto` from T1
**Requirement**: WRK-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Interface exposes `publish(event: VideoAcceptedDto): Promise<boolean>`
- [x] Fake records calls and returns success/failure based on configuration
- [x] Unit tests for the fake pass: `npm test -- fake-event-publisher`
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T4: Implement VideoValidationRequested consumer

**What**: Implement `ValidationConsumer` to consume `VideoValidationRequested`, reject missing `processingRequestId`, deduplicate by `eventId`, and publish `VideoAccepted`.
**Where**: `src/validation/validation.consumer.ts`
**Depends on**: T2, T3
**Reuses**: `EventPublisher` and `DuplicateChecker` ports; `VideoValidationRequestedDto` and `VideoAcceptedDto`
**Requirement**: WRK-01, WRK-02, WRK-03, WRK-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Consumer method validates `processingRequestId` presence and throws/logs without publishing when absent
- [x] Duplicate `eventId` skips publishing and returns cleanly
- [x] Valid message publishes `VideoAccepted` with a new `eventId`, same `processingRequestId`, and `occurredAt`
- [x] FFprobe, FFmpeg, S3, and ZIP are not referenced in this file
- [x] Quick gate passes: `npm test -- validation.consumer`

**Tests**: unit
**Gate**: quick

---

### T5: Wire consumer and ports into AppModule

**What**: Register `ValidationConsumer`, concrete `EventPublisher`, and `DuplicateChecker` providers in `AppModule`.
**Where**: `src/app.module.ts`, `src/validation/validation.module.ts`
**Depends on**: T4
**Reuses**: Generated `AppModule` from Nest scaffold
**Requirement**: WRK-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ValidationModule` exists and is imported by `AppModule`
- [x] `EventPublisher` and `DuplicateChecker` are provided as injectable tokens
- [x] `ValidationConsumer` is discoverable by Nest
- [x] Build gate passes: `npm run build && npm run lint`

**Tests**: none
**Gate**: build

---

### T6: Add unit tests for ValidationConsumer

**What**: Cover valid input, missing `processingRequestId`, duplicate `eventId`, and publisher failure scenarios for `ValidationConsumer`.
**Where**: `src/validation/validation.consumer.spec.ts`
**Depends on**: T5
**Reuses**: Fake publisher and in-memory duplicate checker from T2/T3; Nest `Test.createTestingModule`
**Requirement**: WRK-01, WRK-02, WRK-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Valid message produces one `VideoAccepted` call with correct fields
- [x] Missing `processingRequestId` produces no publish call
- [x] Duplicate `eventId` produces no publish call
- [x] Publisher failure propagates so the consumer would not ack
- [x] Quick gate passes: `npm test -- validation.consumer`

**Tests**: unit
**Gate**: quick

---

### T7: Add e2e wiring test for the validation flow

**What**: Add a minimal e2e test that bootstraps the application with fake broker providers and invokes the consumer end-to-end.
**Where**: `test/validation.e2e-spec.ts`
**Depends on**: T6
**Reuses**: `Test.createTestingModule` pattern from `test/app.e2e-spec.ts`
**Requirement**: WRK-01, WRK-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] E2E test bootstraps the Worker module with fake publisher and duplicate checker
- [x] Invoking the consumer with a valid DTO publishes `VideoAccepted`
- [x] Invoking with duplicate `eventId` does not publish a second event
- [x] Full gate passes: `npm test && npm run test:e2e`

**Tests**: e2e
**Gate**: full

---

## Phase Execution Map

```
Phase 1 → Phase 2

Phase 1:  T1 → T2
Phase 1:  T1 → T3
Phase 1:  T2 → T4
Phase 1:  T3 → T4
Phase 2:  T4 → T5
Phase 2:  T5 → T6
Phase 2:  T6 → T7
```

Execution is strictly sequential - there is no intra-phase parallelism. A single agent works one task at a time, in order.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Create local DTOs | 2 cohesive DTO files | ✅ Granular |
| T2: Create DuplicateChecker port and in-memory impl | 1 interface + 1 implementation | ✅ Granular |
| T3: Create EventPublisher port and fake | 1 interface + 1 fake implementation | ✅ Granular |
| T4: Implement VideoValidationRequested consumer | 1 consumer class | ✅ Granular |
| T5: Wire consumer and ports into AppModule | 1 module wiring change | ✅ Granular |
| T6: Add unit tests for ValidationConsumer | 1 spec file | ✅ Granular |
| T7: Add e2e wiring test | 1 e2e spec file | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | No incoming arrow | ✅ Match |
| T2 | T1 | Arrow from T1 to T2 | ✅ Match |
| T3 | T1 | Arrow from T2 to T3 | ✅ Match |
| T4 | T2, T3 | Arrows from T3 to T4 | ✅ Match |
| T5 | T4 | Arrow from T4 to T5 | ✅ Match |
| T6 | T5 | Arrow from T5 to T6 | ✅ Match |
| T7 | T6 | Arrow from T6 to T7 | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Entity / DTO | none | none | ✅ OK |
| T2 | Domain / service logic (port) | unit | unit | ✅ OK |
| T3 | Domain / service logic (port) | unit | unit | ✅ OK |
| T4 | Domain / service logic (consumer) | unit | unit | ✅ OK |
| T5 | Entity / config / module | none | none | ✅ OK |
| T6 | Domain / service logic | unit | unit | ✅ OK |
| T7 | Module wiring / broker port | e2e | e2e | ✅ OK |
