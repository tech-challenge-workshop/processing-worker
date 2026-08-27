# Worker Initial Vertical Slice Validation

**Date**: 2026-08-27
**Spec**: `.specs/features/initial-vertical-slice/spec.md`
**Diff range**: `2f4aa7b..HEAD` (c934761)
**Verifier**: independent sub-agent (author != verifier)

---

## Task Completion

| Task | Status   | Notes |
| ---- | -------- | ----- |
| T1   | Done     | DTOs exist with exact spec fields; build passes |
| T2   | Done     | DuplicateChecker interface + in-memory impl; 3 unit tests pass |
| T3   | Done     | EventPublisher interface + fake; 3 unit tests pass |
| T4   | Done     | ValidationConsumer validates, dedups, publishes; 4 unit tests pass |
| T5   | Done     | ValidationModule imported by AppModule; build + lint pass |
| T6   | Done     | Consumer unit tests cover valid/missing/duplicate/failure |
| T7   | Done     | E2e wiring test bootstraps AppModule; 2 e2e tests pass |

All 7 tasks marked done; none blocked or partial.

---

## Spec-Anchored Acceptance Criteria

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion expression | Result |
| --- | --- | --- | --- |
| AC1: WHEN Worker receives `VideoValidationRequested` with `eventId`, `processingRequestId`, `ownerUserId`, `sourceStorageKey`, `occurredAt` THEN publish `VideoAccepted` with a NEW `eventId`, same `processingRequestId`, same `occurredAt` | One published event; `eventId` is new (not input's); `processingRequestId` and `occurredAt` equal input | `src/validation/validation.consumer.spec.ts:45` - `expect(publisher.publishedEvents).toHaveLength(1)`; `:47` - `expect(event.processingRequestId).toBe(dto.processingRequestId)`; `:48` - `expect(event.occurredAt).toBe(dto.occurredAt)`; `:49` - `expect(event.eventId).not.toBe(dto.eventId)` | PASS (newness asserted via inequality only - see spec-precision note) |
| AC2: IF `processingRequestId` is absent THEN reject and SHALL NOT publish `VideoAccepted` | Throws rejection error; zero published events | `src/validation/validation.consumer.spec.ts:55` - `rejects.toThrow(ValidationRejectedError)`; `:58` - `expect(publisher.publishedEvents).toHaveLength(0)` | PASS |
| AC3: IF same validation `eventId` delivered again THEN SHALL NOT publish another `VideoAccepted` | Still exactly one published event after second call | `src/validation/validation.consumer.spec.ts:66` - `expect(publisher.publishedEvents).toHaveLength(1)`; `test/validation.e2e-spec.ts:50` - `expect(publisher.publishedEvents).toHaveLength(1)` | PASS |
| AC4: Worker SHALL NOT invoke FFprobe, FFmpeg, S3, or ZIP creation | No references to those tools anywhere in new code | `grep -rniE "ffprobe|ffmpeg|s3|zip"` over `src/validation src/messaging` returns only test fixture string `sourceStorageKey: 's3://bucket/key'` (data, not invocation) | PASS (negative constraint verified by absence) |

**Status**: All 4 ACs covered. 1 spec-precision note (non-blocking).

**Spec-precision note (AC1)**: Spec requires a *new* `eventId`. Code generates `randomUUID()` (`src/validation/validation.consumer.ts:39`), but the test asserts only `expect(event.eventId).not.toBe(dto.eventId)` (`validation.consumer.spec.ts:49`) — inequality, not that the value is a well-formed fresh UUID. The inequality assertion is a reasonable proxy and the code is correct, but the assertion under-specifies the "new UUID" requirement. Flagged as a minor spec-precision gap, not a failure.

---

## Discrimination Sensor

| Mutation | File:line | Description | Killed? |
| --- | --- | --- | --- |
| 1 | `src/validation/validation.consumer.ts:34` | Flipped `if (isDuplicate)` -> `if (!isDuplicate)` (invert dedup gate) | KILLED (3 consumer tests failed) |
| 2 | `src/validation/validation.consumer.ts:39` | Changed `eventId: randomUUID()` -> `eventId: dto.eventId` (reuse input id) | KILLED (`validation.consumer.spec.ts:49` caught reused id) |
| 3 | `src/validation/validation.consumer.ts:45` | Removed `if (!published) { throw ... }` (swallow publish failure) | KILLED (`validation.consumer.spec.ts:73` expected rejection) |

**Sensor depth**: lightweight (3 behavior-level mutations on highest-risk new code)
**Result**: 3/3 killed - PASS

**Isolation**: scratch worktree at `/tmp/pw-sensor` (HEAD) with symlinked node_modules; mutations applied in scratch only; `git worktree remove --force` after each run. Baseline `git status --porcelain` = ` M package-lock.json`; post-sensor porcelain identical. No `git stash` used.

---

## Interactive UAT Results

Not performed - backend-only message-flow slice; automated checks are sufficient per validate.md level 3.

---

## Code Quality

| Principle | Status |
| --- | --- |
| No features beyond what was asked | Yes |
| No abstractions for single-use code | Yes (ports are justified by testability + design) |
| No unnecessary "flexibility" added | Yes |
| Only touched files required for task | Yes |
| Didn't "improve" unrelated code | Yes (only app.module.ts wiring + new files) |
| Matches existing patterns/style | Yes (NestJS scaffold conventions) |
| Would senior engineer approve? | Yes |
| Tests map to ACs and are non-shallow (spot-check: AC3 duplicate) | Yes |
| Spec-anchored outcome check (asserted values match spec) | Yes (1 minor precision note on AC1 new-UUID) |
| Per-layer Coverage Expectation met: domain 1:1 ACs; routes happy+edge+error | Partial - e2e covers happy + duplicate but NOT publish-failure error path (covered in unit only) |
| Every test in scope maps to a spec AC, listed edge case, or Done-when criterion (no unclaimed tests) | Yes |
| Documented guidelines followed: `package.json` test/lint/build scripts; no extra coverage thresholds configured | Yes |

---

## Edge Cases

- [x] **Publish-failure edge**: "IF publishing `VideoAccepted` fails THEN the Worker SHALL leave the input message unacknowledged for technical redelivery." Handled by `throw` at `src/validation/validation.consumer.ts:46` (propagates so the message is not acked); `mark` runs only after successful publish so a failed publish is retried on redelivery. Test: `src/validation/validation.consumer.spec.ts:69-76`. PASS.
- [x] Note: duplicate `eventId` before a successful publish (publish failed on first delivery) is NOT marked, so redelivery correctly retries. Confirmed by code ordering (`publish` then `mark`).

---

## Gate Check

- **Gate command** (Build, from tasks.md): `npm run build && npm run lint && npm test && npm run test:e2e`
- **Result**:
  - `npm run build`: exit 0
  - `npm run lint`: exit 0 (no errors)
  - `npm test`: 4 suites, 11 passed, 0 failed, 0 skipped
  - `npm run test:e2e`: 2 suites, 3 passed, 0 failed, 0 skipped
- **Test count before feature** (at `2f4aa7b`): unit 1 (`app.controller.spec`), e2e 1 (`app.e2e-spec`) = 2 total
- **Test count after feature** (HEAD): unit 11, e2e 3 = 14 total
- **Delta**: +12 new tests (unit +10, e2e +2)
- **Skipped tests**: none
- **Failures**: none
- **Test integrity**: no tests deleted; scaffold assertions unchanged; count increased. No regression.

---

## AppleDouble Jest Config Examination

Commit `c934761` adds `"testPathIgnorePatterns": ["/node_modules/", "\\.\\_"]` to `package.json` (unit) and `test/jest-e2e.json` (e2e).

- **Is it a minimal AppleDouble fix?** Yes. The JSON string `\\.\\_` decodes to the regex `\.\_`, which matches the 2-char sequence `._` — the prefix of every macOS AppleDouble resource-fork shadow file (`._<name>`). On this external HIKSEMI volume, 218 `._*` files exist (notably inside `.git/`); without the ignore, Jest could collect `._*.spec.ts` shadows and produce spurious failures. The change is a single-pattern ignore addition with no behavioral test logic change.
- **Is it scope creep?** No. It touches only test-runner config, not feature code; it carries no new dependency, no new abstraction, and no feature logic. The pattern is marginally broad (ignores any path containing `._`, not just leading-dot-underscore names), but no legitimate path in this codebase contains `._`, so practical risk is zero.
- **Verdict**: minimal environment fix for AppleDouble on macOS, not scope creep. Acceptable.

The same commit also applies Prettier line-wrapping to `validation.consumer.spec.ts` (import + `createDto` signature) — purely cosmetic formatting, no behavior change. Acceptable.

---

## Fix Plans (if issues found)

No blocking fixes required. Two non-blocking improvements noted:

### Improvement 1 (Minor, optional): Strengthen AC1 "new eventId" assertion

- **Root cause**: Test asserts `not.toBe(dto.eventId)` only; does not verify the new value is a well-formed UUID.
- **Fix task**: In `src/validation/validation.consumer.spec.ts:49`, additionally assert the new eventId matches a UUID v4 regex (e.g. `expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)`).
- **Priority**: Minor

### Improvement 2 (Minor, optional): Add publish-failure edge to e2e suite

- **Root cause**: The Test Coverage Matrix (`tasks.md:23`) expects e2e to cover "happy path + publish-failure edge", but `test/validation.e2e-spec.ts` covers only happy + duplicate. Publish-failure is covered at unit level only.
- **Fix task**: Add an e2e case in `test/validation.e2e-spec.ts` that configures the fake publisher to fail and asserts the consumer rejects, exercising the wiring end-to-end.
- **Priority**: Minor

---

## Requirement Traceability Update

Update spec.md requirement statuses:

| Requirement | Previous Status | New Status |
| --- | --- | --- |
| WRK-01 | Complete | Verified |
| WRK-02 | Complete | Verified |
| WRK-03 | Complete | Verified |
| WRK-04 | Complete | Verified |

---

## Summary

**Overall**: Ready

**Spec-anchored check**: 4/4 ACs matched spec outcome; 1 minor spec-precision note (AC1 new-UUID inequality-only assertion)
**Sensor**: 3/3 mutations killed
**Gate**: 14 tests passed, 0 failed, 0 skipped

**What works**:
- Valid message publishes one `VideoAccepted` with new eventId, same processingRequestId and occurredAt
- Missing processingRequestId rejects and publishes nothing
- Duplicate eventId publishes nothing on repeat
- Publish failure propagates (no ack) and does not mark the eventId (redelivery-safe)
- No FFprobe/FFmpeg/S3/ZIP invocations
- Build + lint + unit + e2e all green; test count grew +12 with no deletions or weakened assertions
- AppleDouble Jest ignore is a minimal environment fix, not scope creep

**Issues found** (non-blocking):
1. AC1 new-eventId asserted by inequality only (minor spec-precision)
2. e2e suite omits publish-failure edge required by coverage matrix (covered in unit)

**Next steps**: Optionally apply the two minor improvements; no re-verification needed for PASS. Feature is ready to mark Verified.
