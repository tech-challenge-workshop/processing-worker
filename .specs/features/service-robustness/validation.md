## Validation: service-robustness (worker) — PASS with open items

**Diff range:** `6365050..4a36fcc` (T1 `aef4f0c`, T2 `04f5e57`, T3 `4a36fcc`), branch `fix/service-robustness`
**Verifier:** independent, final round (leftovers are open items)
**Environment:** `node:22-alpine` + ffmpeg, `rabbitmq:4-management-alpine` loaded with `fiap-x-platform/rabbitmq/definitions.json` (HTTP 204), `rustfs/rustfs:1.0.0`. All on `spf-wrkver-net`, with `CI=true`, `RABBITMQ_TEST_URL` and `STORAGE_ENDPOINT` set. All resources removed afterwards.

### Gate (build level)
lint 0 | typecheck 0 | unit 172/172 | e2e 57/57, 10/10 suites, none skipped | build 0.
Logged hook order: `onModuleDestroy -> beforeApplicationShutdown -> onApplicationShutdown` (@nestjs/core 11.2.3).

### Per-AC evidence
| AC | Result | Evidence |
| --- | --- | --- |
| ROB-06 AC1: a job settling between the hooks is not acked and publishes no terminal event | PASS | `test/processing.e2e-spec.ts:297-372`. A test provider releases the packager in `beforeApplicationShutdown` and awaits `handled`. The test asserts `settled == []` and `publishedTypes == ['ProcessingStarted']` |
| ROB-06 AC2: moving the flag to `onApplicationShutdown` fails that test | PASS | Mutant M1 is killed (e2e 1 failed) |
| ROB-06: the release hook really ran | PASS | The test asserts the full `hookOrder` array, and that array records `beforeApplicationShutdown`. A caveat: this pins the test fixture's hook order, not the worker's |
| ROB-07 AC3: the window is documented with the eventId dedup | PASS (with a minor wording gap) | `src/processing/shutdown-signal.ts:8-12`. See F3 |
| ROB-08 AC1-3 + edge case | PASS | `src/testing/broker-guard.spec.ts` covers `{CI:true}`=fail, `{}`=skip, `{URL}`=run and `{CI:false}`=skip. Real runs with no URL: `CI=true` gives 1 failed, `CI=0` gives 1 failed, `CI=''` gives 2 skipped, `CI=false` gives 2 skipped. With the URL: 2/2 passed |
| ROB-08: the broker suite uses the guard | PASS | `test/broker.e2e-spec.ts:22,24,51`. The wiring itself has no test (F1) |
| ROB-09 AC4: only `MessageRejectedError` is permanent | PASS | `settle-failed-message.ts:40-42`. Unit tests cover both classes and the requeue-after-backoff behaviour |
| ROB-09 AC5: non-JSON still reaches `video-validation.dlq` on its first delivery | PASS | The broker suite test "dead-letters a non-JSON validation message on its first delivery" passes on a real broker. In `@nestjs/microservices` 11.2.3, `server-rmq.js:160-199`: a non-JSON body has no `pattern`, so `handleEvent` finds no handler and calls `nack(msg,false,false)` |
| V49 items (1-4) of `catalog-messaging-hardening/validation.md` | Closed | M11 is now killed (M1 below). The window is documented. M8 is killed at unit level (M3). The dead `SyntaxError` branch is removed |

### SyntaxError requeue-forever search (ROB-09)
- Only one `JSON.parse` exists in `src/`: `src/media/ffprobe-probe.ts:83`. It is wrapped locally and returns `{readable:false}`, so a `SyntaxError` never escapes it.
- The consumers do no JSON parsing of their own. Nest parses the body before any handler runs.
- No Worker path was found where a message-caused `SyntaxError` now requeues forever.
- A related loop exists, but it predates this change and is out of scope (F2).

### Changed existing tests
- `settle-failed-message.spec.ts`: the `SyntaxError` row was moved from the dead-letter `it.each` to a new requeue-after-backoff test (`:72-83`). ROB-09 requires that inversion, so this is not a weakening. A bare `MessageRejectedError` row was also added.
- `test/broker.e2e-spec.ts`: only the guard expression changed, to `mode`. The assertions are untouched.
- No test was weakened.

### Discrimination sensor (scratch worktree; full unit + full e2e per mutant)
| ID | Mutant | Result |
| --- | --- | --- |
| M1 | Flag set in `onApplicationShutdown` | Killed (e2e 1 failed) |
| M2 | Flag check removed from the consumer | Killed (e2e 3 failed) |
| M3 | Guard fail branch returns `skip` | Killed (unit 1 failed) |
| M4 | `CI=false` counted as set | Killed (unit 1 failed) |
| M5 | `SyntaxError` permanent again | Killed (unit 2 failed) |
| M6 | `MessageRejectedError` transient | Killed (unit 6, e2e 1 failed) |
| M7 | CI narrowed to `CI === 'true'` only (a `CI=1` or `CI=0` run skips) | **Survived** |
| M8 | CI checked before the URL, so fail beats run | Killed by the gate only (the broker e2e fails with CI+URL). Unit tests miss it: no `{CI, URL}` case |
| M9 | Flag set in `beforeApplicationShutdown` | Killed (e2e 1 failed) |
| M10 | Broker suite's `if (mode === 'fail')` block disabled | **Survived** the gate. With `CI=true` and no URL, the suite goes green: 2 skipped, rc 0 |

**Score: 8/10 killed** (6/6 of the suggested set).

### Findings
1. **[Low] The suite-to-guard wiring is untested (M10).** `test/broker.e2e-spec.ts:24-30`
   - `brokerSuiteMode` is unit-tested, but nothing checks that the suite fails when the mode is `fail`.
   - Scenario: a refactor drops or inverts the `if (mode === 'fail')` block. CI then loses `RABBITMQ_TEST_URL`, and the broker suite skips green. This is V49's M8 again, one level up.
   - Residual risk: the wiring is 3 lines and was proven by hand in T2 and here.
   - Also: `test/s3-object-storage.e2e-spec.ts:24` still has its own inline guard, `!endpoint && process.env.CI`. It does not use the tested function, and its semantics differ: there `CI=false` fails.
2. **[Info, pre-existing] JSON with a `null` payload requeues forever.**
   - Scenario: a body `{"pattern":"ProcessingQueued","data":null}` makes `dto.processingRequestId` throw a `TypeError` (`processing.consumer.ts:81`, `validation.consumer.ts:70`).
   - That `TypeError` is transient, so the message requeues on every backoff, indefinitely.
   - This was not introduced by ROB-09 (before it, a `TypeError` was already transient), and it is not a `SyntaxError`.
3. **[Info] ROB-07's note names only `ProcessingCompleted`.** `src/processing/shutdown-signal.ts:9-11`
   - The same window after the check at `processing.consumer.ts:116` also covers `ProcessingFailed` (`:128-138`).
   - The note's AD-010 citation is loose: AD-010 is the Catalog outbox decision, and its trade-off states that consumers deduplicate by `eventId`.
   - The note is accurate in substance.
4. **[Info] ROB-08 guard edge cases.**
   - `CI=0` and `CI=FALSE` fail, and `CI=''` skips. That is fail-safe and matches "any non-empty value other than `'false'`".
   - It is not pinned by tests (M7 survives), so a future narrowing to `=== 'true'` would pass unnoticed.

### Open items (Validar depois)
- F1: add a test for the suite wiring, e.g. a spawned Jest run with `CI=true` and no URL, or move the describe selection into a tested helper. Align the S3 suite's guard with it.
- F4: add `{CI:'1'}` → fail and `{CI:'true', RABBITMQ_TEST_URL}` → run to `broker-guard.spec.ts`.
- F2: decide whether a non-object payload should be a `MessageRejectedError` (out of scope here).
- F3: mention `ProcessingFailed` in the window note.

### Lessons signal
- Unit-testing a guard function moves the untested surface from the rule to the call site. A test-infrastructure guard needs its wiring pinned, or it needs to be tested through the runner.
- The lifecycle test pattern worked. Acting *inside* a hook and asserting the recorded hook order killed both the later-hook mutants (M1 and M9).
- Removing a "dead" error class from a permanent-failure list needs evidence of where the framework drops the input. Here that meant reading the transport code (`server-rmq.js`) and the real-broker DLQ test.
- Worker agents: never append to a worktree's `.git` file. It is a gitdir pointer, not a directory. Run git on the host when the container does not mount the main repo.
