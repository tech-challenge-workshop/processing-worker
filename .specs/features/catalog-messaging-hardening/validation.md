## Validation: catalog-messaging-hardening (worker) — PASS with open items

# Catalog Messaging Hardening (worker) Validation

**Date**: 2026-09-26
**Spec**: `processing-worker/.specs/features/catalog-messaging-hardening/spec.md`
**Diff range**: `24e0f6b..8ff1915` (T1-T4), branch `fix/catalog-messaging-hardening`
**Verifier**: independent sub-agent (author ≠ verifier). This is the final round; the leftovers below are open items for "Validar depois".

---

## Task Completion

| Task | Status | Notes |
| --- | --- | --- |
| T1 (MSG-12) | ✅ Done | Health suite 6/6 both with a clean env and with all four `STORAGE_*` set to junk |
| T2 (MSG-13) | ✅ Done | RM-07 precedence note present in `real-media-processing/spec.md:80` |
| T3 (MSG-14) | ✅ Done | Behaviour change (user decision 2026-09-26) implemented as designed |
| T4 (MSG-15) | ✅ Done, deviation accepted | The `SyntaxError` discrimination criterion cannot be met; see Deviation |

---

## Spec-Anchored Acceptance Criteria

| Criterion | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| MSG-12 AC1: storage vars set to any value → same results as unset | Readiness bodies identical | `test/health.e2e-spec.ts:55` sets the junk env for every run; `:75` clears it; the readiness assertions are unchanged. Verified by running it: 6/6 clean, and 6/6 with `STORAGE_ENDPOINT=http://127.0.0.1:9` plus junk bucket and keys | ✅ PASS |
| MSG-12 AC2: vars restored when the suite ends | Prior values back | `test/health.e2e-spec.ts:79` restores; `:210` `expect(readStorageEnv()).toEqual(dirtyShell)` | ✅ PASS |
| MSG-13 AC1: over-limit and non-MP4/MOV → `DURACAO_EXCEDIDA` | `{accepted:false, failureCode:'DURACAO_EXCEDIDA'}` | `src/validation/ffprobe-video-validator.spec.ts:196-208` `resolves.toEqual({accepted:false, failureCode:'DURACAO_EXCEDIDA'})` (mkv, 601 s) | ✅ PASS |
| MSG-13 AC2: within limit and non-MP4/MOV → `FORMATO_INVALIDO` | `FORMATO_INVALIDO` | `ffprobe-video-validator.spec.ts:210-219` (mkv, 8 s) | ✅ PASS |
| MSG-14 AC1: close while packager runs → no ack | `ack`/`nack` never called | `test/processing.e2e-spec.ts:274` and `:282` `expect(settled).toEqual([])`. The packager resolves at `:271` and rejects at `:279`, both after `app.close()` at `:267` | ✅ PASS |
| MSG-14 AC2: no `ProcessingCompleted` or `ProcessingFailed` | Only `ProcessingStarted` | `processing.e2e-spec.ts:275` and `:283` `publishedTypes).toEqual(['ProcessingStarted'])`. The same assertions also pin that Started is still published | ✅ PASS |
| MSG-14 normal path unchanged | Completed/Failed and ack as before | The existing processing e2e cases (e.g. `processing.e2e-spec.ts:91`) and the consumer unit spec are unchanged apart from the `ShutdownSignal` provider. M12 (flag stuck on) turns 7 of them red | ✅ PASS |
| MSG-15 AC1: messages beyond the prefetch stay `ready` | With prefetch 1 and 3 queued: 2 ready | `test/broker.e2e-spec.ts:143` `eventually(...)=2`; `:147` still 2 after 1 s; `:148` `packagerCalls` = 1 | ✅ PASS |
| MSG-15 AC2: non-JSON → rejected without requeue, reaches the DLQ on first delivery | DLQ +1; `x-death` count 1, reason `rejected` | `broker.e2e-spec.ts:161-164` (DLQ = 1, source = 0); `:174` body `not json`; `:182-186` `x-death` `{queue:'video-validation', reason:'rejected', count:1}` | ✅ PASS (see Deviation) |
| MSG-15 AC3: `CI` set and URL unset → fail, not skip | Suite fails | `broker.e2e-spec.ts:22-28`. Run with `CI=true` and no URL: rc=1, 1 failed / 2 skipped. Locally without `CI`: rc=0, 2 skipped. No gate test pins it; see M8 | ✅ PASS (by run) |
| Edge: the platform's queue names and policy are used | Queues come from `definitions.json` | The suite declares no arguments. The broker was loaded with the platform files, and the `dead-letter` policy was present | ✅ PASS |

**Status**: ✅ All ACs covered. One spec-precision gap: MSG-15 AC2 says "the Worker SHALL reject"; the reject comes from Nest's RMQ transport, not from Worker code (see Deviation).

### Deviation judged: `SyntaxError` as transient leaves the DLQ case green

Confirmed, and acceptable.

- `node_modules/@nestjs/microservices/server/server-rmq.js:248-254` (`parseMessageContent`) swallows the `JSON.parse` error and returns the raw string.
- The packet then has no pattern, so `handleEvent` (`:194-198`) finds no handler and calls `nack(msg, false, false)`. No Worker handler runs.
- The only other `JSON.parse` in `src`, at `src/media/ffprobe-probe.ts:83`, catches its own error.
- So the `SyntaxError` branch of `isPermanentFailure` (`src/messaging/settle-failed-message.ts:35`) is **dead for non-JSON bodies** in the current composition. Only its unit spec (`settle-failed-message.spec.ts:37`) reaches it.
- Mutation evidence:
  - M9, which removes `SyntaxError`, survives the broker suite.
  - M10, which makes Nest's no-handler nack requeue, turns the DLQ case red (expected 1, received 0).
- AC2 is met at the process boundary: the body is rejected without requeue, and `x-death` shows count 1 with reason `rejected`, so it was dead-lettered on its first delivery.

---

## Discrimination Sensor

Run in a scratch `git worktree` at 8ff1915, in `node:22-alpine` + ffmpeg, with `CI=true`, a private RustFS and a private `rabbitmq:4-management` loaded with the platform's definitions and conf.

| # | Mutation | File | Result |
| --- | --- | --- | --- |
| M1 | Flag never set (`closing = false` in `onModuleDestroy`) | `src/processing/shutdown-signal.ts:16` | ✅ Killed: both MSG-14 cases |
| M2 | Flag check removed (`if (false)`) | `src/processing/processing.consumer.ts:116` | ✅ Killed: both MSG-14 cases |
| M3 | Ack sent before the packager (ack at handler entry) | `processing.consumer.ts:45` | ✅ Killed: both MSG-14 cases |
| M12 | Flag stuck on (`closing = true` initially) | `shutdown-signal.ts:9` | ✅ Killed: 7 normal-path processing cases |
| M11 | Flag set in `onApplicationShutdown` instead of `onModuleDestroy` | `shutdown-signal.ts:15` | ❌ **Survived** |
| M5 | Health clear removed | `test/health.e2e-spec.ts:75` | ✅ Killed: 3 readiness cases |
| M6 | Health restore removed | `test/health.e2e-spec.ts:79` | ✅ Killed: restore case |
| M7 | Precedence checks swapped | `src/validation/ffprobe-video-validator.ts:97-102` | ✅ Killed: mkv 601 s case |
| M4a | `PREFETCH_PROCESSING=3` (test parameter) | `test/broker.e2e-spec.ts:124` | ✅ Killed: prefetch case |
| M4b | Production prefetch +2 | `src/messaging/consumer-options.ts:51` | ✅ Killed: prefetch case |
| M9 | `SyntaxError` treated as transient | `src/messaging/settle-failed-message.ts:35` | Survives the broker suite (expected: dead branch); ✅ killed by `settle-failed-message.spec.ts` |
| M10 | Nest no-handler nack requeues (in `node_modules`, scratch only) | `server-rmq.js:197` | ✅ Killed: DLQ case |
| M8 | CI guard removed | `test/broker.e2e-spec.ts:22-28` | ❌ **Survived the gate** (the gate sets the URL). Removing the guard does change the run with `CI=true` and no URL: rc 1 → 0 |

**Sensor depth**: expanded (13 mutants)
**Result**: 11/13 killed by the full gate. Survivors: M11 (a real test gap) and M8 (inherent to a CI-environment guard).

---

## Code Quality

| Principle | Status |
| --- | --- |
| Minimum code | ✅ |
| Surgical changes | ✅ Consumer change limited to the flag check and a return tag |
| No scope creep | ✅ |
| Matches patterns | ✅ Health save/clear/restore follows `composition.e2e-spec.ts`; CI step mirrors the RustFS step |
| Spec-anchored outcome check | ✅ |
| Existing tests not weakened | ✅ The diff only adds to test files; the consumer spec only gains a `ShutdownSignal` provider in its 4 modules (`processing.consumer.spec.ts:70,218,346,494`) |
| Every test maps to a requirement | ✅ |

---

## Edge Cases and Findings (open items)

1. **[Low-Med] The hook ordering the design relies on is not pinned (M11).**
   - Where: `src/processing/shutdown-signal.ts:15`; the tests release the packager only after `app.close()` has fully resolved (`test/processing.e2e-spec.ts:267-271`).
   - What the tests miss: moving the flag to `beforeApplicationShutdown` or `onApplicationShutdown` passes them.
   - Failure scenario: a job whose packager settles during `dispose` (after `onModuleDestroy`, before `onApplicationShutdown`) would, under that refactor, publish `ProcessingCompleted` and ack on a closing channel.
   - Fix: release the held packager from inside a later-ordered hook (e.g. a test provider's `beforeApplicationShutdown`), or assert `isClosing` from there.
2. **[Low] Residual window after the flag check.**
   - Where: `src/processing/processing.consumer.ts:116`. The flag is read once, right after the packager settles.
   - Failure scenario: shutdown begins during `publish(ProcessingCompleted)` or `mark`. The terminal event goes out, the ack then fails on the closed channel, and the message is redelivered. The result is a duplicate `ProcessingCompleted` with the same derived `eventId` (RM-18), which downstream dedupes.
   - Scope: outside the ACs, which only cover "while the packager is running". Recorded, not blocking.
3. **[Low] The CI guard is pinned by no automated test (M8).**
   - Where: `test/broker.e2e-spec.ts:22-28`.
   - It is proven only by running without the URL. This is inherent to an environment guard, and it was verified by hand here.
4. **[Info] The `SyntaxError` branch is dead for wire input.**
   - Where: `src/messaging/settle-failed-message.ts:30-35`. Its doc comment ("a body that is not JSON") describes a path that Nest pre-empts.
   - Suggestion: correct the comment, or drop the branch.
5. **[Info] The spec Goal is broader than MSG-12.**
   - The Goal says "the suite gives the same result in any shell", but MSG-12 only makes the health suite independent.
   - With junk `STORAGE_*` exported, the full e2e run fails `test/s3-object-storage.e2e-spec.ts` (2 tests). That suite uses `STORAGE_ENDPOINT` as its target by design, so this is not an AC failure. The Goal wording should be narrowed.
6. **[Info] CI broker image drift.**
   - CI uses `rabbitmq:4-management`; the compose uses `-alpine` with `user: 0:0`.
   - Replicated the CI step (non-root, files at mode 644 as a checkout leaves them): it started, `video-validation.dlq` and the `dead-letter` policy were present, and the wait loop's checks passed.
   - The platform repo is publicly readable (`git ls-remote` with no credentials works), and the local `rabbitmq/` matches `origin/main` 6e0d2e6.

---

## Gate Check

- **Gate command**: `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` (node:22-alpine + ffmpeg, `CI=true`, `STORAGE_ENDPOINT`, `RABBITMQ_TEST_URL`)
- **Result**: lint 0, typecheck 0, unit 165/165, e2e 56/56 (10 suites), build 0; 0 skipped
- **Test count before feature**: unit 163, e2e 51 (tasks.md)
- **Test count after feature**: unit 165, e2e 56
- **Delta**: +2 unit, +5 e2e
- **Skipped tests**: none
- **Failures**: none

---

## Requirement Traceability Update

| Requirement | Previous Status | New Status |
| --- | --- | --- |
| MSG-12 | Implementing | ✅ Verified |
| MSG-13 | Implementing | ✅ Verified |
| MSG-14 | Implementing | ✅ Verified (open item: hook ordering unpinned) |
| MSG-15 | Implementing | ✅ Verified (open items: guard pinned only by a run; AC2 met via the Nest transport) |

---

## Summary

**Overall**: ✅ Ready, with open items

**Spec-anchored check**: 10/10 ACs plus the edge case matched; 1 spec-precision gap (MSG-15 AC2: who rejects)
**Sensor**: 11/13 killed (survivors M11, M8)
**Gate**: 165 unit + 56 e2e passed, 0 skipped

**Open items for "Validar depois"**: findings 1-6 above.

---

## Lessons signal

- **Surviving mutant M11:** a lifecycle-ordering claim ("flag set before the publishers close") needs a test that acts *during* the shutdown hooks, not after `close()` resolves. Otherwise any hook passes.
- **Surviving mutant M8:** environment guards (`CI` without the URL) are only discriminated by a gate run in that environment. Record the manual run as the evidence, or add a meta-test that spawns jest with `CI=true` and no URL.
- **Spec-precision gap / deviation:** "the Worker SHALL reject" hid the fact that the framework transport rejects before any app code runs. Before writing a discrimination criterion that mutates a branch, confirm the input can reach that branch.
- **Goal vs AC drift:** a feature Goal ("any shell") broader than its ACs (health suite only) left one e2e suite shell-dependent. Keep Goals at the AC's scope, or add the missing ACs.
