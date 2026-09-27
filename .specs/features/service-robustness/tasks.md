# Service Robustness Tasks — worker

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.** (In this project's sessions the skill is not registered by name; the user has authorized reading it from `.agents/skills/tlc-spec-driven/` by path.)

---

**Design**: `.specs/features/service-robustness/design.md`
**Status**: Draft

---

## Test Coverage Matrix

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Consumer lifecycle | e2e | A job that settles between shutdown hooks is not acked and publishes no terminal event | `test/processing.e2e-spec.ts` | `npm run test:e2e` |
| Test guard | unit | The four environment cases | `src/testing/*.spec.ts` | `npm test` |
| Settle helper | unit + integration | Only `MessageRejectedError` is permanent; the broker suite still shows non-JSON reaching the DLQ | `src/messaging/*.spec.ts`, `test/broker.e2e-spec.ts` | both |

## Gate Check Commands

> Run the gates in `node:22-alpine` with ffmpeg, because the host has no ffmpeg. Use your own RustFS (`STORAGE_ENDPOINT`) and a RabbitMQ loaded with the platform's definitions (`RABBITMQ_TEST_URL`), with `CI=true`.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | Unit-only tasks | `npm test` |
| Full | e2e tasks | `npm test && npm run test:e2e` |
| Build | Last task | `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` |

---

## Execution Plan

### Phase 1

```
T1
T2
T3
```

---

## Task Breakdown

### T1: Pin the shutdown hook order and document the window

**What**: Add the `beforeApplicationShutdown` release test, and the window note in `ShutdownSignal`.
**Where**: `test/processing.e2e-spec.ts` (+ `src/processing/shutdown-signal.ts`)
**Depends on**: None
**Reuses**: The shutdown tests from spec A's T3, and the recording channel
**Requirement**: ROB-06, ROB-07

**Tools**:
- MCP: NONE
- Skill: NONE

**Done when**:
- [x] The test passes, and moving the flag to `onApplicationShutdown` in a scratch copy fails it
- [x] The hook order is logged once in the test composition and recorded in the status note
- [x] The window note is in place
- [x] Full gate passes

**Tests**: e2e
**Gate**: full

**Status**: ✅ Done. Observed hook order on `@nestjs/core` 11.2.3: `onModuleDestroy -> beforeApplicationShutdown -> onApplicationShutdown`, the order the design assumes. The test also asserts that order, so it cannot pass without the release hook running. Negative: with the flag set in `onApplicationShutdown`, only the new test fails (it acks and publishes `ProcessingCompleted`); spec A's two shutdown tests still pass, as V49 said. Gate: unit 165/165, e2e 57/57, none skipped.

---

### T2: Test the broker suite's CI guard

**What**: Add `brokerSuiteMode(env)` with unit tests, and have the broker suite use it.
**Where**: `src/testing/broker-guard.ts`
**Depends on**: None
**Reuses**: The guard at `test/broker.e2e-spec.ts:20-28`
**Requirement**: ROB-08

**Tools**:
- MCP: NONE
- Skill: NONE

**Done when**:
- [x] The four cases pass
- [x] Removing the `fail` branch fails a test
- [x] The broker suite behaves as before: with the URL, 2 tests pass; with `CI=true` and no URL, it fails
- [x] Full gate passes

**Tests**: unit
**Gate**: full

**Status**: ✅ Done. `src/testing/broker-guard.ts` plus 4 unit tests. Negatives: with the `fail` branch returning `skip`, the `{CI:'true'}` test fails; with `CI=false` counted as set, the `{CI:'false'}` test fails. Broker suite: with the URL, 2 passed; with `CI=true` and no URL, 1 failed and 2 skipped; with neither, 2 skipped. Gate: unit 169/169, e2e 57/57, none skipped.

---

### T3: Remove the dead `SyntaxError` branch

**What**: `isPermanentFailure` returns true only for `MessageRejectedError`. Its unit tests are updated to assert that a `SyntaxError` is now transient, and its comment is updated.
**Where**: `src/messaging/settle-failed-message.ts`
**Depends on**: None
**Reuses**: Its spec
**Requirement**: ROB-09

**Tools**:
- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Unit: a `SyntaxError` → requeue after the backoff; `MessageRejectedError` → `nack(false)`
- [ ] The broker suite still shows non-JSON reaching `video-validation.dlq` on its first delivery
- [ ] Build gate passes

**Tests**: unit + integration
**Gate**: build

---

## Phase Execution Map

```
Phase 1 (T1 T2 T3)
```

3 tasks.

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 | 1 test + 1 comment | ✅ Granular |
| T2 | 1 function + its use | ✅ Granular |
| T3 | 1 function | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows (within phase) | Status |
| --- | --- | --- | --- |
| T1 | None | — | ✅ Match |
| T2 | None | — | ✅ Match |
| T3 | None | — | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Consumer lifecycle | e2e | e2e | ✅ OK |
| T2 | Test guard | unit | unit | ✅ OK |
| T3 | Settle helper | unit + integration | unit + integration | ✅ OK |
