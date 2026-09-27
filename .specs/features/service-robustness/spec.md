# Service Robustness Specification — worker

## Problem Statement

The spec A Verifier left four items in the Worker (V49):

- **The shutdown hook is not pinned.** The flag's hook ordering is untested: setting it in `onApplicationShutdown` instead of `onModuleDestroy` passes every test, because the tests release the packager only after `app.close()` finishes.
- **A window follows the flag check.** Shutdown can begin while `ProcessingCompleted` is being published, after the flag was checked.
- **The CI guard has no test.** The broker suite's rule "fail when `CI` is set and there is no broker" is proven only by hand.
- **One branch is dead.** The `SyntaxError` branch in `settle-failed-message.ts` never runs for non-JSON input, because Nest nacks those messages before any Worker code runs.

## Goals

- [ ] The shutdown guarantee holds for a job that settles at any moment during `app.close()`
- [ ] Every guard in the Worker's test suite is itself tested, and no dead code claims a behaviour it does not provide

## Out of Scope

| Feature | Reason |
| --- | --- |
| Closing the window after the flag check | Decided: accepted and documented; the Catalog deduplicates the repeated event |
| Catalog and Notification items | Their own spec files (`processing-catalog/.specs/features/service-robustness/context.md`) |

---

## Assumptions & Open Questions

Decisions of 2026-09-26 are in `processing-catalog/.specs/features/service-robustness/context.md`.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| The window after the flag check | Accepted. Documented beside `ShutdownSignal` and in the spec | Decided | y |
| The `SyntaxError` branch | Removed. Only `MessageRejectedError` is permanent | Decided; the broker suite keeps proving non-JSON → DLQ | y |
| How the CI guard is tested | The guard becomes a small exported function, unit-tested for three cases: `CI` set with no URL, `CI` unset with no URL, and a URL set | A process-level test of Jest skipping would be slow and indirect | y |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: The shutdown guarantee holds at every point of close ⭐ MVP

**User Story**: As the operator, I want a job that settles while the app is closing never to ack or publish a terminal event, whatever shutdown phase it settles in.

**Why P1**: A later hook would silently reopen MSG-14.

**Acceptance Criteria**:

1. WHEN a job's packager settles during the shutdown phase between `onModuleDestroy` and `onApplicationShutdown` THEN the Worker SHALL NOT ack the message and SHALL NOT publish `ProcessingCompleted` or `ProcessingFailed`.
2. IF the flag were set only in `onApplicationShutdown` THEN the test for AC1 SHALL fail.
3. The accepted window after the flag check SHALL be documented beside `ShutdownSignal`, stating that the Catalog deduplicates a repeated event by `eventId`.

**Independent Test**: A test-only provider releases the held packager from its `beforeApplicationShutdown` hook. The channel records nothing.

---

### P2: Test guards are tested; dead code is gone

**User Story**: As a maintainer, I want the broker suite's CI guard covered by a test, and the dead `SyntaxError` branch removed.

**Why P2**: V49.

**Acceptance Criteria**:

1. WHEN `CI` is set and `RABBITMQ_TEST_URL` is unset THEN the guard function SHALL report that the suite must fail.
2. WHEN `CI` is unset and the URL is unset THEN it SHALL report skip.
3. WHEN the URL is set THEN it SHALL report run.
4. `isPermanentFailure` SHALL return true only for `MessageRejectedError`.
5. WHEN a non-JSON message is published to `video-validation` THEN it SHALL still reach `video-validation.dlq` on its first delivery (the broker suite).

**Independent Test**: A unit test with `CI=true` and no URL gets "fail". The broker suite stays green after the branch is removed.

---

## Edge Cases

- WHEN `CI` is set to `false` THEN the guard SHALL treat it as unset, as GitHub Actions only ever sets `true`.

---

## Requirement Traceability

`ROB-` is shared: `processing-catalog` owns `ROB-01` to `ROB-03`, `notification-service` `ROB-04` and `ROB-05`, and this service `ROB-06` to `ROB-09`.

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| ROB-06 | P1: Hook ordering pinned (V49) | Execute | Implementing |
| ROB-07 | P1: Accepted window documented (V49) | Execute | Implementing |
| ROB-08 | P2: CI guard tested (V49) | Tasks | In Tasks |
| ROB-09 | P2: Dead `SyntaxError` branch removed (V49) | Tasks | In Tasks |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 4 total, 4 mapped to tasks, 0 unmapped

---

## Success Criteria

- [ ] Moving the flag to a later hook fails a test
- [ ] Removing the CI guard fails a test

---

## Dependencies

None.
