# Full Lifecycle Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/full-lifecycle/design.md`
**Status**: Done

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `.specs/features/local-docker-integration/tasks.md` (prior matrix for this repository), `test/jest-e2e.json`, `package.json` scripts. No coverage threshold is configured anywhere in the repository.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Messaging routing | unit | Every event type asserted by destination **and** pattern; an unroutable type asserted to throw | `src/messaging/*.spec.ts` | `npm test` |
| Consumers | unit | Happy path, each rejection path, malformed payload, duplicate delivery, publication failure blocking the ack | `src/validation/*.spec.ts`, `src/processing/*.spec.ts` | `npm test` |
| Validation port and default | unit | The default accepts; the port is driven by a double for every defined failure code | `src/validation/*.spec.ts` | `npm test` |
| Messaging DTOs | none | Build gate only - they declare shape and carry no behaviour | `src/messaging/dto/*.ts` | build gate only |
| Job lifecycle | e2e | Ordered event sequences for a successful and a failed job | `test/*.e2e-spec.ts` | `npm run test:e2e` |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | After tasks with unit tests only | `npm test` |
| Full | After tasks touching consumers or the e2e path | `npm test && npm run test:e2e` |
| Build | After phase completion or DTO-only tasks | `npm run lint && npm test && npm run test:e2e && npm run build` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order.

**Phase 1 is a prerequisite, not a preference.** Adding an event type before routing is explicit would publish it to the wrong destination and report success.

### Phase 1: Explicit routing

```
T1 → T2 → T3
```

### Phase 2: Validation outcome

```
T4 → T5 → T6 → T7
```

### Phase 3: Processing outcome

```
T8 → T9 → T10
```

### Phase 4: End-to-end

```
T11
```

---

## Task Breakdown

### T1: Declare the event type union and route table

**What**: Add `WorkerEventType` and the `EVENT_ROUTES` map naming a client token and a pattern for each type.
**Where**: `src/messaging/event-routes.ts`
**Depends on**: None
**Reuses**: The queue and pattern names already registered in `messaging.module.ts`
**Requirement**: LC-01, LC-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] All five event types are present in the union
- [x] Every type maps to a distinct client token and pattern
- [x] A test asserts the mapping is total over the union, so a new type without a route fails the type check
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T2: Route by declared type in the publisher

**What**: Change `publish` to take the event type from the caller and resolve its destination through `EVENT_ROUTES`, removing the `'zipStorageKey' in event` discrimination.
**Where**: `src/messaging/rabbitmq-event-publisher.ts` (modify)
**Depends on**: T1
**Reuses**: The existing `lastValueFrom` + `catchError` shape that turns a transport error into `false`
**Requirement**: LC-01, LC-02, LC-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] No inference from payload shape remains anywhere in the file
- [x] Each event type is asserted to reach its own client with its own pattern
- [x] An unroutable type throws rather than falling back to a default destination
- [x] A transport error still resolves to `false` rather than throwing
- [x] Existing publisher tests are updated to the new signature with no assertion weakened
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T3: Register the three new destinations

**What**: Add client registrations for the rejected, started and failed destinations, and extend the fake publisher to record the destination.
**Where**: `src/messaging/messaging.module.ts` (modify)
**Depends on**: T2
**Reuses**: The existing `ClientsModule.register` entries and their options
**Requirement**: LC-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Three new clients are registered with durable queues, matching the existing entries
- [x] Every token named in `EVENT_ROUTES` resolves at boot
- [x] Build gate passes: `npm run lint && npm test && npm run test:e2e && npm run build`

**Tests**: unit
**Gate**: build

---

### T4: Declare the validation port

**What**: Add the `VideoValidator` interface and its `ValidationOutcome` result type.
**Where**: `src/validation/video-validator.interface.ts`
**Depends on**: T3
**Reuses**: The `DuplicateChecker` port style already used in this folder
**Requirement**: LC-05, LC-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] The outcome is a discriminated union of accepted and rejected, with the failure code required only on rejection
- [x] The failure code type is the closed vocabulary from the foundation
- [x] Quick gate passes: `npm test`

**Tests**: none
**Gate**: quick

---

### T5: Add the permissive default validator

**What**: Add the implementation that accepts every input, preserving today's behaviour behind the port.
**Where**: `src/validation/accept-all-video-validator.ts`
**Depends on**: T4
**Reuses**: The behaviour currently inlined in `ValidationConsumer`
**Requirement**: LC-05

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Every input is accepted
- [x] The class name states plainly that it accepts everything, so a green suite is not mistaken for real validation
- [x] Quick gate passes: `npm test`

**Tests**: unit
**Gate**: quick

---

### T6: Add the rejection event contract

**What**: Add `VideoRejectedDto` carrying `eventId`, `processingRequestId`, `failureCode` and `occurredAt`.
**Where**: `src/messaging/dto/video-rejected.dto.ts`
**Depends on**: T5
**Reuses**: `video-accepted.dto.ts` shape
**Requirement**: LC-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] The DTO matches the payload the Catalog's rejection consumer expects
- [x] Quick gate passes: `npm test`

**Tests**: none
**Gate**: quick

---

### T7: Publish the validation outcome

**What**: Change `ValidationConsumer` to consult the validator and publish `VideoAccepted` or `VideoRejected` accordingly.
**Where**: `src/validation/validation.consumer.ts` (modify)
**Depends on**: T6
**Reuses**: The existing duplicate check, ack and nack policy
**Requirement**: LC-05, LC-06, LC-07, LC-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] An accepted video publishes `VideoAccepted` and no rejection
- [x] A rejected video publishes `VideoRejected` carrying the reported code, and no acceptance
- [x] Each defined failure code is driven through a validator double and asserted
- [x] A generated `eventId` is asserted to be a well-formed fresh identifier, not merely different from the input
- [x] A redelivered job publishes no second outcome
- [x] A publication failure prevents the ack
- [x] Full gate passes: `npm test && npm run test:e2e`

**Tests**: unit
**Gate**: full

---

### T8: Add the started event contract

**What**: Add `ProcessingStartedDto` carrying `eventId`, `processingRequestId`, `attemptId` and `occurredAt`.
**Where**: `src/messaging/dto/processing-started.dto.ts`
**Depends on**: T7
**Reuses**: `processing-completed.dto.ts` shape
**Requirement**: LC-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] The DTO matches the payload the Catalog's start consumer expects
- [x] Quick gate passes: `npm test`

**Tests**: none
**Gate**: quick

---

### T9: Add the failed event contract

**What**: Add `ProcessingFailedDto` carrying `eventId`, `processingRequestId`, `attemptId`, `failureCode` and `occurredAt`.
**Where**: `src/messaging/dto/processing-failed.dto.ts`
**Depends on**: T8
**Reuses**: `processing-completed.dto.ts` shape
**Requirement**: LC-11

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] The DTO matches the payload the Catalog's failure consumer expects
- [x] Quick gate passes: `npm test`

**Tests**: none
**Gate**: quick

---

### T10: Publish the processing progress and outcome

**What**: Change `ProcessingConsumer` to publish `ProcessingStarted` before any work, then exactly one of `ProcessingCompleted` or `ProcessingFailed`.
**Where**: `src/processing/processing.consumer.ts` (modify)
**Depends on**: T9
**Reuses**: The existing duplicate check and nack policy
**Requirement**: LC-09, LC-10, LC-11, LC-12, LC-13

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ProcessingStarted` is published before any work, asserted by event order and not only by presence
- [x] A successful job publishes `ProcessingCompleted` with the `attemptId` and deterministic key
- [x] A failing job publishes `ProcessingFailed` with `PROCESSAMENTO_FALHOU`
- [x] Exactly one of completed or failed is published per job, never both and never neither
- [x] A failure to publish `ProcessingStarted` prevents the work from beginning and nacks the job
- [x] A redelivered job creates no second attempt and publishes no second outcome
- [x] Full gate passes: `npm test && npm run test:e2e`

**Tests**: unit
**Gate**: full

---

### T11: Cover both job outcomes end to end

**What**: Extend the e2e suite to assert the ordered event sequence for a successful job and for a failed one.
**Where**: `test/processing.e2e-spec.ts` (modify)
**Depends on**: T10
**Reuses**: The existing e2e setup and the fake publisher extended in T3
**Requirement**: LC-04, LC-09, LC-10, LC-11, LC-13

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] A successful job produces `ProcessingStarted` then `ProcessingCompleted`, in that order
- [x] A failed job produces `ProcessingStarted` then `ProcessingFailed`, in that order
- [x] Every published event is asserted by destination and pattern, which is what would have caught the routing defect this slice removes
- [x] Replaying either job publishes nothing further
- [x] Build gate passes: `npm run lint && npm test && npm run test:e2e && npm run build`

**Tests**: e2e
**Gate**: build

**Commit**: `feat(lifecycle): report every processing outcome`

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 ------→ T2 ------→ T3
Phase 2:  T4 ------→ T5 ------→ T6 ------→ T7
Phase 3:  T8 ------→ T9 ------→ T10
Phase 4:  T11

Phase boundaries (the last task of a phase gates the first task of the next):
          T3 ------→ T4
          T7 ------→ T8
          T10 ------→ T11
```

Total: 11 tasks. This packs into two batches at the ~7-task worker budget: Phases 1-2 (7 tasks) and Phases 3-4 (4 tasks). Execute should offer batch sub-agents.

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1: Event type union and routes | 1 file | ✅ Granular |
| T2: Route by declared type | 1 class | ✅ Granular |
| T3: Register destinations | 1 module | ✅ Granular |
| T4: Validation port | 1 interface | ✅ Granular |
| T5: Default validator | 1 class | ✅ Granular |
| T6: Rejection DTO | 1 file | ✅ Granular |
| T7: Publish validation outcome | 1 consumer | ✅ Granular |
| T8: Started DTO | 1 file | ✅ Granular |
| T9: Failed DTO | 1 file | ✅ Granular |
| T10: Publish processing outcome | 1 consumer | ✅ Granular |
| T11: End-to-end coverage | 1 suite | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | no inbound arrow | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |
| T4 | T3 | T3 → T4 (phase boundary) | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |
| T7 | T6 | T6 → T7 | ✅ Match |
| T8 | T7 | T7 → T8 (phase boundary) | ✅ Match |
| T9 | T8 | T8 → T9 | ✅ Match |
| T10 | T9 | T9 → T10 | ✅ Match |
| T11 | T10 | T10 → T11 (phase boundary) | ✅ Match |

No task depends on a task in a later phase.

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Messaging routing | unit | unit | ✅ OK |
| T2 | Messaging routing | unit | unit | ✅ OK |
| T3 | Messaging routing | unit | unit | ✅ OK |
| T4 | Messaging DTO-equivalent type declaration | none | none | ✅ OK |
| T5 | Validation default | unit | unit | ✅ OK |
| T6 | Messaging DTO | none | none | ✅ OK |
| T7 | Consumer | unit | unit | ✅ OK |
| T8 | Messaging DTO | none | none | ✅ OK |
| T9 | Messaging DTO | none | none | ✅ OK |
| T10 | Consumer | unit | unit | ✅ OK |
| T11 | Job lifecycle | e2e | e2e | ✅ OK |

The four `Tests: none` tasks all declare shape and carry no behaviour, which is what the matrix assigns `none` to. Each is proven where it is used: T4 by T5 and T7, T6 by T7, and T8 and T9 by T10 and T11, every one of which asserts the published payload rather than the declaration.

---

## Execution record

**Completed**: 2026-09-21 · merged in [#4](https://github.com/tech-challenge-workshop/processing-worker/pull/4)

Final gate: lint, typecheck, 57 unit tests, 14 e2e, build - all green.

### Deviations

| Deviation | Why |
| --- | --- |
| T3 executed before T2 | The dependency runs the other way: the publisher resolves five client tokens through `EVENT_ROUTES` and cannot start until they are registered |
| T2 touched more files than its `Where` named | Changing the `publish` signature is a contract change that cannot land in halves - the interface, the publisher, the fake and both call sites must move together |
| A `FramePackager` port was added, which the plan did not list | The failure branch is otherwise untestable: the placeholder work never throws, and the skill forbids a task that produces unverified code. Same seam shape as `VideoValidator`; S4 fills both |

### Existing assertions updated

Nine assertions expected a single published event per job. They contradicted LC-09,
which requires the start to precede the outcome, so they now assert the ordered pair
rather than a count. None was weakened.
