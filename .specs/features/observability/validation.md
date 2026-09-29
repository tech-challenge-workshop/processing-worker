# Observability Validation

**Date**: 2026-09-28
**Spec**: `.specs/features/observability/spec.md`
**Diff range**: `origin/main..HEAD` = `776afba..84d096b` (3 docs commits, 16 task commits, and 4 post-verification commits: `6ff206c`, `badeaf8`, `0510791`, `84d096b`)
**Verifier**: independent sub-agent (author ≠ verifier), round 2 (final round)

**Verdict**: FAIL ❌. The round-1 gaps are closed. M14, M15 and M16 are now killed by e2e tests that read what the Worker's own logger wiring writes. OBS-31 and OBS-35 are verified.

OBS-36 still fails, through a path that neither round 1 nor the fixes covered. An S3 SDK error carries the storage key as enumerable properties (`Key`, `Resource`) parsed from the S3 error body. The validation consumer rethrows that error, and Nest's `RpcExceptionsHandler` calls `logger.error(exception)`. pino's `err` serializer then writes those properties into the log line, and nothing redacts them.

A scratch probe on the real broker, using the real logger wiring and the real `S3ObjectStorage`, produced this error line:

`"err":{…,"Key":"sources/secret-key.mp4","Resource":"/fiapx/sources/secret-key.mp4",…}`

One new mutant also survives: M17, where the production default log sink is no longer stdout.

---

## Round 1 → Round 2

| Round-1 finding | Fix commit(s) | Round-2 result |
| --- | --- | --- |
| Fix 1: OBS-35 and the log half of OBS-31 unproven through the Worker's wiring (M14, M15 survived) | `badeaf8` (`configureApp` + `LOG_DESTINATION`), `0510791` (e2e) | ✅ Closed. `test/observability.e2e-spec.ts:525-580` boots through `configureApp` with a capture stream. The in-scope shutdown warn carries `correlationId: 'w-7'`, and every line is structured JSON. M14 and M15 are killed. |
| Fix 2: OBS-36 key in error-message strings (`s3-object-storage.ts:80`, `in-memory-object-storage.ts:32`; M16 survived) | `84d096b` | ✅ Message path closed. Both messages now name no key. Unit tests (`s3-object-storage.spec.ts:107-120`, `in-memory-object-storage.spec.ts:50-58`) and e2e `:582-628` kill M16, M21 and M22. ❌ **The error-property path is still open** (Gap 1 below). |
| Observation 2: `pino`/`pino-http` only as peers | `6ff206c` | ✅ Declared in `dependencies`. |
| Observation 1: `RpcExceptionsHandler` lines lack `correlationId` | none (recorded as an open observation in tasks.md) | Confirmed by the probe: the level-50 line has `service` but no `correlationId`. Judged not strictly required by the AC; see Observations. |

**`main.ts` behavior after the `configureApp` refactor**: unchanged. Checked by reading the code and by M18/M23:

- `src/main.ts:8-13` still does `NestFactory.create(AppModule, { bufferLogs: true })`, then composition, `startAllMicroservices`, `listen`, `flushLogs`.
- `src/configure-app.ts:13-38` holds the same `useLogger(app.get(Logger))`, the two `connectMicroservice` calls, and the same `&&` readiness binding. The binding is identical to `origin/main:src/main.ts:22-26`.
- The default sink is `LOG_DESTINATION = null` (`src/observability/observability.module.ts:18`). With `null`, the factory returns the bare `pinoHttp` options (`:23`), so nestjs-pino builds pino on its default stdout destination. That is the same as before.
- One ordering difference: the default parameter `consumers = consumerOptions()` now runs before `useLogger`. `consumerOptions` (`src/messaging/consumer-options.ts:35`) is a pure env read that neither logs nor throws, so this has no effect.
- The e2e harness differs from `main.ts` only in two ways: explicit queue names, and `init()` instead of `listen()`.

---

## Task Completion

| Task | Status | Notes |
| ---- | ------ | ----- |
| T1–T15 | ✅ Done | As in round 1. |
| F1 (logger wiring proof) | ✅ Done | `badeaf8`, `0510791`. Done-when boxes checked in `tasks.md`. M14 and M15 were re-verified as killed by this Verifier. |
| F2 (keys out of error messages) | ⚠️ Done for message strings | `84d096b`. The AC outcome still fails through structured error properties (Gap 1). |

---

## Spec-Anchored Acceptance Criteria

> Line numbers are taken at HEAD `84d096b`. Unit specs outside `src/storage` are unchanged since round 1, so their citations still hold. E2e citations were re-derived.

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| ------------------------- | -------------------- | ----------------------- | ------ |
| OBS-31 WHEN a consumer receives a message THEN set the log context from its `correlationId` before handling and clear it when the handler settles | The handler sees the id, and lines logged in the handler carry it; the context is `undefined` after settle | `src/messaging/with-correlation.spec.ts:17-40` (seen `w-7`, `toBeUndefined()` after resolve and after reject); `src/validation/validation.consumer.spec.ts:331-351`; `src/processing/processing.consumer.spec.ts:576-639`; **log join on the broker**: `test/observability.e2e-spec.ts:571-576` - `expect(inHandler()).toHaveLength(1); expect(inHandler()[0]).toMatchObject({ level: 40, context: 'ProcessingConsumer', correlationId: 'w-7' })` | ✅ PASS (M14, M15 killed) |
| OBS-32 validation outcomes carry the consumed id | `correlationId` on the wire equals the consumed id | e2e `test/observability.e2e-spec.ts:270` - `video.accepted` → `correlationId: 'w-7'`; `:323` - `video.rejected` → `'w-8'`; unit `src/messaging/rabbitmq-event-publisher.spec.ts:131-155` (`toEqual`, omitted rather than `null`) | ✅ PASS (M20 killed: unit 3, e2e 6 failed) |
| OBS-33 processing outcomes carry the consumed id | Same, on started, completed and failed | e2e `:289`, `:293` (`p-3`), `:327` (`p-4`), `:544` (`processing.started` → `w-7`) | ✅ PASS (M20 killed) |
| OBS-34 absent or invalid id → fresh id, still publish, never fail the message | UUID on the outcome; message acked; no coercion | e2e `:347` - `expect(accepted?.correlationId).toMatch(UUID_V4_REGEX)`; `:366` (numeric `7`); unit `src/messaging/with-correlation.spec.ts:42-76`, `src/observability/correlation-context.spec.ts:53-82`, `src/validation/validation.consumer.spec.ts:362-383` | ✅ PASS |
| OBS-35 every Worker log line is JSON with `timestamp`, `level`, `msg`, `service`, and the current `correlationId` | Every captured line (bootstrap, consumers, error lines) parses with those keys; in-scope lines carry the consumed id | `test/observability.e2e-spec.ts:511-523` - for every captured line, `expect(line).toEqual(expect.objectContaining({ timestamp: expect.any(Number), level: expect.any(Number), msg: expect.any(String), service: 'processing-worker' }))`, run at `:570` and `:624`; `correlationId` at `:572-576`; unit `src/observability/logger.config.spec.ts:62-76` | ✅ PASS (M14, M15, M23 killed). The error-line `correlationId` is covered under Observations. |
| OBS-36 a job log line never contains the source or ZIP storage key, or a presigned URL | No captured line contains the key, in any field or string | `test/observability.e2e-spec.ts:577`, `:625` - `expect(logLines.join('\n')).not.toContain('secret-key')` (shutdown warn; S3 no-body and in-memory missing-key errors); `src/storage/s3-object-storage.spec.ts:118-119`; `src/storage/in-memory-object-storage.spec.ts:55-56`; `src/observability/logger.config.spec.ts:88-151` | ❌ **GAP**. S3 service errors keep `Key`/`Resource` as enumerable properties. `RpcExceptionsHandler` logs `logger.error(exception)` (`node_modules/@nestjs/microservices/exceptions/base-rpc-exception-filter.js:26`). pino serializes them under `err`, and `REDACT_PATHS` (`src/observability/logger.config.ts:24-36`) lists neither. The scratch probe emitted `"Key":"sources/secret-key.mp4","Resource":"/fiapx/sources/secret-key.mp4"` (see Probe P1). |
| OBS-37 `/metrics` includes the four families with bounded labels | 200; all series present | `src/observability/metrics.controller.spec.ts:27-43`; e2e `:385-427`, `:480-495` | ✅ PASS |
| OBS-38 rejected → `rejected` +1, `accepted` not incremented | rejected 1, accepted 0 | `src/validation/validation.consumer.spec.ts:410-424`; e2e `:416-418` - each outcome series `toBe(1)` | ✅ PASS |
| OBS-39 processing outcome +1 and elapsed-seconds observation | Count and duration measured from handler start to settle | `src/processing/processing.consumer.spec.ts:693-730` (`durationSum >= 0.045`); e2e `:419-421` - `duration_seconds_count` `toBe(2)` | ✅ PASS (⚠️ flag 1) |
| OBS-40 in-flight +1 during a job, −1 on settle, including on failure | 1 during; 0 after success, throw and shutdown | `src/validation/validation.consumer.spec.ts:426-467`; `src/processing/processing.consumer.spec.ts:732-807`; e2e `:422-427`, `:466-475` | ✅ PASS |
| OBS-41 broker unreachable → `/health` 503, `/health/live` 200 | 503 `{status:'error', rabbitmq:false}`; live 200 | e2e `test/observability.e2e-spec.ts:674` (200 while connected), `:682-690` - `expect(readiness.status).toBe(503)`, `expect(liveness.status).toBe(200)`, `/metrics` 200 | ✅ PASS (M18 killed). Readiness now runs through the production `configureApp` binding, not a mirror. |
| OBS-42 no auth and no access-log lines for metrics and health | 200 without credentials; no access-log line | `src/observability/logger.config.spec.ts:153-171`; e2e `:485-488` | ✅ PASS (⚠️ flag 2) |

**Status**: ❌ 11/12 ACs covered with spec-matching assertions. OBS-36 fails on a real leak path. There are 2 ⚠️ spec-precision flags, both carried over from round 1 and judged outcome-met.

**Payload/conjunction rule**:

- **Log line (OBS-31/35)**: the conjunction "carries the consumed id" **and** "is structured JSON" is asserted on the same captured line set (`:570-576`). The same job's wire payload (`processing.started`, `w-7`, `:544`) is asserted in the same test, which joins the log to the event.
- **OBS-36**: the new e2e checks cover the message string and the shutdown warn. They do not cover the serialized `err` properties, because the in-test S3 failure (`Body: undefined`) is a plain `Error` with no SDK fields. So the test's negative assertion is sound, but its inputs never exercise that path.

**Spec-precision flags** (carried over from round 1, still judged outcome-met):

1. OBS-39 and Edge case 1 name a "consumed counter" that design.md dropped on purpose. A handler that throws counts no outcome.
2. The OBS-42 access-log exclusion is an exact `req.url` match (`src/observability/logger.config.ts:62-65`).

---

## Discrimination Sensor

**Scratch isolation**:

- Each mutation ran in a fresh `git worktree add --detach /tmp/worker-v2-<mN> HEAD` with the real `node_modules` symlinked.
- A script applied the mutation and asserted exactly one match.
- The full unit suite (`npx jest`) and the full e2e suite (`RABBITMQ_TEST_URL=amqp://guest:guest@localhost:5672`) ran in the worktree.
- The worktree was then removed with `--force`.
- The real tree's `git status --porcelain` hash (`6c25628…`: the 3 uncommitted `.specs` files) matched the pre-sensor baseline after every mutant and after the probe.
- `git worktree list` ends with only the real tree.

| Mutation | File:line | Description | Killed? |
| -------- | --------- | ----------- | ------- |
| M14 (re-run) | `src/observability/observability.module.ts:21` | Logger mixin reads `new CorrelationContext()` instead of the shared singleton | ✅ Killed. e2e `writes every line as JSON … carries the consumed id` (`correlationId` missing) |
| M15 (re-run) | `src/configure-app.ts:19` | `app.useLogger(app.get(Logger))` removed | ✅ Killed. e2e: both log-wiring tests (no line captured) |
| M16 (re-run) | `src/processing/processing.consumer.ts:145` | Shutdown warn interpolates `dto.sourceStorageKey` | ✅ Killed. e2e `… no storage key` |
| M17 (new) | `src/observability/observability.module.ts:18` | Default `LOG_DESTINATION` becomes a discard stream instead of `null`, so production logs go nowhere instead of to stdout | ❌ **Survived**. Unit 238/238, e2e 66/66. Every test overrides the provider. → Gap 2 |
| M18 (new) | `src/configure-app.ts:37` | Readiness binding dropped (`subscribe(() => undefined)`) | ✅ Killed. e2e `answers /health 503 once the broker is unreachable…` (200 while connected fails) |
| M19 (new) | `src/configure-app.ts:34` | Readiness `&&` → `\|\|` (ready if either consumer is connected) | ⚠️ Survived, but equivalent under the spec. OBS-41 only defines broker loss, where both consumers are down. The `&&` binding existed before this feature (`origin/main:src/main.ts:26`). Observation, not a gap. |
| M20 (new, = round-1 M1) | `src/messaging/rabbitmq-event-publisher.ts:44` | Publisher drops the id (`return event`) | ✅ Killed. Unit 3, e2e 6 failed |
| M21 (new) | `src/storage/s3-object-storage.ts:82` | Key restored in the no-body error message | ✅ Killed. Unit `… naming no key (OBS-36)`, e2e `keeps the storage key out…` |
| M22 (new) | `src/storage/in-memory-object-storage.ts:34` | Key restored in the missing-key error message | ✅ Killed. Unit and e2e (same pair) |
| M23 (new) | `src/observability/observability.module.ts:23` | Factory ignores the injected destination | ✅ Killed. e2e: both log-wiring tests |

**Sensor depth**: expanded (10 mutations: the 3 round-1 survivors, the default sink, the readiness binding ×2, the publisher, the storage messages ×2, and the destination plumbing).
**Result**: 8/10 killed, 2 survived (M17 is a real survivor; M19 is spec-equivalent). FAIL ❌.

**Probe P1 (evidence, not a mutant)**:

- **Setup**: scratch worktree `/tmp/worker-v2-probe`, removed afterwards; porcelain matched the baseline. The probe added a test to the scratch copy of `test/observability.e2e-spec.ts`. The test's validator calls a real `S3ObjectStorage.fromConfig({ endpoint: 'http://127.0.0.1:47123', … }).download(...)` against a local HTTP server. The server answers GetObject with a MinIO-style `403 AccessDenied` XML body containing `<Key>sources/secret-key.mp4</Key>` and `<Resource>/fiapx/sources/secret-key.mp4</Resource>`.
- **Run**: a `VideoValidationRequested` with that `sourceStorageKey` and `correlationId: 'w-9'` was sent on the real broker, into the Worker composed by `configureApp` with the capture stream.
- **Result**: the probe's `not.toContain('secret-key')` failed. The captured line was `{"level":50,…,"service":"processing-worker","context":"RpcExceptionsHandler","err":{"type":"AccessDenied","message":"Access Denied.",…,"Code":"AccessDenied","Key":"sources/secret-key.mp4","BucketName":"fiapx","Resource":"/fiapx/sources/secret-key.mp4",…}}`. It has no `correlationId`.
- **Mechanism**: `decorateServiceException` in `@smithy/core` copies unmodeled error-body fields onto the exception, and pino's `err` serializer keeps enumerable properties.
- **When it happens in production**: whenever a HEAD succeeds and the following GetObject fails with an S3 error body that names the key. `FfprobeVideoValidator.validate` does HEAD then download (`src/validation/ffprobe-video-validator.ts:72`, `:88`), and the consumer rethrows (`src/validation/validation.consumer.ts:85`). Examples:
  - MinIO- or RustFS-style `SlowDown`/`InternalError`/`AccessDenied` bodies, which include `Key`/`Resource`;
  - a `NoSuchKey` race between HEAD and GET.
- **The processing path**: packager download errors are swallowed without logging (`processing.consumer.ts:137-141`), so that path does not leak.

**OBS-41 flake check**: the health e2e (TCP relay) passed in all 10 full-e2e runs where the health code was untouched (the gate plus 9 mutants; M18 failed it on purpose). No flake reproduced (0/10).

---

## Interactive UAT Results

Not performed. This is a backend/observability feature.

---

## Code Quality

| Principle | Status |
| --------- | ------ |
| Minimum code / no scope creep | ✅ `configureApp` has two call sites (`main.ts`, e2e). `LOG_DESTINATION` is a single-purpose seam, and its default is documented |
| Surgical changes | ✅ Fix commits touch only the wiring, the two storage messages, and tests |
| Matches patterns | ✅ |
| Spec-anchored outcome check | ❌ 11/12 (OBS-36) |
| Per-layer coverage | ⚠️ The wiring is now e2e-covered through `configureApp`. The production default of the new seam is untested (M17) |
| Every test maps to an AC/edge/Done-when | ✅ New e2e tests map to OBS-31/35/36 and F1/F2 |
| Documented guidelines followed | ✅ `.github/workflows/ci.yml` gates re-run green |

SPEC_DEVIATION markers: no new ones. The round-1 set is unchanged and still judged acceptable.

Changed-test integrity: the `bindReadiness` mirror was removed in favor of the production `configureApp`, which is stronger. `in-memory-object-storage.spec.ts` changed its expected message and added a negative assertion. No assertion was weakened.

---

## Edge Cases

- [x] Handler throws before publishing → gauge released, no outcome (e2e `:445-478`).
- [x] Numeric or object `correlationId` → replaced, never stringified (e2e `:355-370`; unit as in round 1).
- [x] Shutdown mid-job → left for redelivery, gauge released. It is now also proven on the broker, with the in-scope warn line and the message back in the queue (e2e `:525-580`).
- [ ] ⚠️ Scrape during a job → consistent snapshot. The guarantee is structural. Observation (unchanged).

---

## Gate Check

- **Gate command**: `npm run lint && npm run typecheck && npm test && RABBITMQ_TEST_URL=amqp://guest:guest@localhost:5672 npm run test:e2e && npm run build` (ffmpeg shim on `PATH`, `STORAGE_ENDPOINT` unset)
- **Exit codes (captured by this Verifier on HEAD `84d096b`)**:
  - lint: exit 0
  - typecheck: exit 0
  - `npm test`: exit 0 (31/31 suites, 238 passed)
  - `npm run test:e2e`: exit 0 (10 suites passed + 1 skipped; 66 passed, 2 skipped)
  - build: exit 0
- **Test count before feature** (`origin/main`): 172 unit + 55 e2e = 227
- **Test count after feature**: 238 unit + 66 e2e = 304
- **Delta**: +77, 0 deletions (+1 unit and +2 e2e since round 1)
- **Skipped tests**: 2 in `test/s3-object-storage.e2e-spec.ts` (`STORAGE_ENDPOINT` unset). These skips predate the feature and are justified.
- **Failures**: none

---

## Fix Plans

### Fix 3 (Major): redact storage keys carried as error properties (OBS-36)

- **Root cause**: S3 SDK exceptions carry `Key`/`Resource` from the error body as enumerable fields. `RpcExceptionsHandler` logs the exception object. `REDACT_PATHS` (`src/observability/logger.config.ts:24-36`) redacts only the named DTO fields and `url`.
- **Fix task**, either of:
  - (a) Add `err.Key`, `err.Resource` (plus the `*.`/`*.*.` forms, for errors logged nested) to the redaction paths. Note that `err.stack` and `err.message` are unaffected.
  - (b) In `S3ObjectStorage`, rethrow SDK errors as a key-free error that keeps `name` and `$metadata`, so that `isNotFound` and any transient classification still work. Drop the SDK error rather than attaching it as `cause`.
- **Test**: in `test/observability.e2e-spec.ts`, add a job whose validator downloads through a real `S3ObjectStorage` pointed at a local HTTP stub. The stub answers GetObject with an S3 error body containing `<Key>`/`<Resource>`. Assert that the error line is logged and that no captured line contains the key. Probe P1 above is a working template.
- **Verify**: revert the fix in scratch; the new test must fail.
- **Priority**: Major. The AC is absolute, and the path is realistic under S3 throttling or errors during the RF-1 load test.

### Fix 4 (Minor): guard the production default of `LOG_DESTINATION` (M17)

- **Root cause**: every test overrides `LOG_DESTINATION`, so the `null` → stdout default is never exercised.
- **Fix task**, either of:
  - extract the `useFactory` into an exported function and unit-test that `null` yields the bare `pinoHttp` options (no second stream), and that the module's provider value is `null`;
  - or add a smoke test that spawns `node dist/main.js` (or `ts-node src/main.ts`) with the broker URL and asserts a JSON line with `service: 'processing-worker'` on the child's stdout.
- **Verify**: M17 is killed.
- **Priority**: Minor. The code is correct at HEAD (read and confirmed); the regression it guards against would silence all production logs.

---

## Requirement Traceability Update

| Requirement | Previous Status (round 1) | New Status |
| ----------- | --------------- | ---------- |
| OBS-31 | ✅ Verified (context); log join pending | ✅ Verified |
| OBS-32..34 | ✅ Verified | ✅ Verified |
| OBS-35 | ❌ Needs Fix | ✅ Verified (error-line `correlationId`: observation) |
| OBS-36 | ❌ Needs Fix | ❌ Needs Fix (Fix 3; the message path is fixed) |
| OBS-37..42 | ✅ Verified | ✅ Verified |

(`spec.md` was not edited by this Verifier. Its OBS-36 row currently reads "e2e proven on job log lines (F1, F2)", which overstates the coverage.)

---

## Summary

**Overall**: ❌ Not Ready - FAIL (final verifier round)

**Spec-anchored check**: 11/12 ACs matched spec outcome; OBS-36 is a gap; 2 ⚠️ spec-precision flags (outcome-met)
**Sensor**: 10 injected, 8 killed, 2 survived (M17 real; M19 spec-equivalent)
**Gate**: lint/typecheck/build exit 0; unit 238/238; e2e 66 passed, 2 S3 skips that predate the feature

**What works**: all of round 1, plus:

- The Worker's real logger wiring (shared ALS store, `useLogger`, pino sink) is proven on the broker: in-scope lines carry the consumed id, and every line is structured JSON.
- Readiness is exercised through the production `configureApp` binding.
- Storage-adapter error messages no longer name the key.

**Issues found**:

- Fix 3: storage key leaked through SDK error properties (OBS-36).
- Fix 4: the default log sink is unguarded (M17).

**Observations (non-blocking)**:

1. **`RpcExceptionsHandler` error lines carry no `correlationId`.** The probe confirms it. The AC says "the **current** `correlationId`", and OBS-31 requires the context to be cleared when the handler settles. Nest logs the rejection after settle, so no id is current, and the AC is not strictly violated. The story text ("each job's correlation id in every Worker log line") points the other way. Worth a follow-up, for example logging the failure inside `withMessageCorrelation` before rethrowing.
2. **M19 (readiness `||`) is spec-equivalent.** The binding predates the feature.
3. **`src/media/temp-workspace.ts:52` logs the temp directory path at error level.** The code predates the feature. The spec's assumption row says temp paths are "debug at most", but no AC covers it, and the path contains `processingRequestId` only, not a storage key.
4. **Decided items unchanged from round 1.** A redelivered message without an id gets a fresh id each time. Health and metrics endpoints are counted in HTTP metrics but not access-logged.
5. **OBS-41 flake**: 0/10 runs.

**Next steps**: this was the final verifier round. Route Fix 3 (and Fix 4) to an implementer, or record them as open items ("Validar depois") for the user to decide.
