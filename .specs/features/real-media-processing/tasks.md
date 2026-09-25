# Real Media Processing Tasks — worker

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/real-media-processing/design.md`
**Status**: Draft

**Tools for every task below**: MCP `NONE`, Skill `NONE`. Nothing here needs a library whose current API has to be resolved at implementation time - the two external dependencies were pinned during Design from the registry (`archiver@8.0.0`, `@aws-sdk/client-s3@3.1137.0`) and the `mc`/FFmpeg command forms were read from their own documentation. If a task turns out to need an unfamiliar API, resolve it through the Knowledge Verification Chain rather than guessing.

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `.specs/features/full-lifecycle/tasks.md` (prior matrix for this repository), `test/jest-e2e.json`, `package.json` scripts. No coverage threshold is configured anywhere in the repository. `ts-jest` does **not** type-check, which is why `npm run typecheck` is part of the build gate rather than an optional step.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Process primitives (runner, temp workspace) | unit | Exercised against the real OS, not a mocked `child_process` or `fs`: exit 0, non-zero exit, a command that outlives its timeout, and cleanup after both a returning and a throwing callback | `src/media/*.spec.ts` | `npm test` |
| Media adapters (probe, extractor, zip builder) | unit | Every branch; the **argument vector** asserted in addition to the output, because a dropped flag is invisible in the result | `src/media/*.spec.ts` | `npm test` |
| Validation implementation | unit | 1:1 with RM-07 and RM-08 acceptance criteria; every `FailureCode` reachable; every listed edge case | `src/validation/*.spec.ts` | `npm test` |
| Frame packager | unit | Happy path, the already-stored short circuit, and a failure at each stage (download, extract, zip, upload) with cleanup asserted | `src/processing/*.spec.ts` | `npm test` |
| Storage port and in-memory adapter | unit | Absence returns `undefined` rather than throwing; round-trip of upload then download | `src/storage/*.spec.ts` | `npm test` |
| Storage S3 adapter | integration | Round-trip against a real endpoint; skipped by its own guard when `STORAGE_ENDPOINT` is unset | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Composition root | e2e | Which adapter and which validator the root selects, with and without credentials | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Consumers and module wiring | e2e | Ordered event sequences for accept, reject, complete, fail, and redelivery | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Dockerfile, DTOs, config constants | none | Build gate only - they declare shape or environment and carry no branching | `Dockerfile`, `src/messaging/dto/*.ts` | build gate only |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | After tasks with unit tests only | `npm test` |
| Full | After tasks touching consumers, wiring, or the e2e path | `npm test && npm run test:e2e` |
| Build | After phase completion or config-only tasks | `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order. Arrows below show **within-phase** dependencies; a task's full `Depends on` list may also reach back into an earlier phase.

### Phase 1: External process foundation

Nothing can run FFmpeg until the binaries are present and there is one correct way to invoke a child process.

```
T1 -> T4
T2 -> T4
T3
```

### Phase 2: Object storage behind a port

```
T5 -> T6
T5 -> T7
T6 -> T7
```

### Phase 3: Validation that opens the file

```
T8 -> T9
T9 -> T10
```

### Phase 4: Extraction and packaging

```
T11 -> T13
T12 -> T13
T13 -> T14
```

### Phase 5: Concurrency, failure and redelivery

```
T15 -> T17
T16 -> T17
T18 -> T17
T19 -> T17
```

---

## Task Breakdown

### Phase 1: External process foundation

### T1: Put FFmpeg and FFprobe in the image

**What**: Install `ffmpeg` in both stages of the image so the binaries exist at runtime.
**Where**: `Dockerfile`
**Depends on**: None
**Reuses**: The existing two-stage `node:22-alpine` layout
**Requirement**: RM-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ffmpeg` and `ffprobe` are both callable in the final stage
- [x] The builder stage is not carrying the media packages it does not use
- [x] The image still starts with `node dist/main`
- [x] Build gate passes: `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build`

**Status**: ✅ Complete
**Tests**: none
**Gate**: build

---

### T2: Add the child-process runner

**What**: One wrapper that runs an external command with a timeout and returns stdout or a typed failure carrying stderr.
**Where**: `src/media/child-process.runner.ts`
**Depends on**: None
**Reuses**: Nothing - this is the new primitive both media adapters build on
**Requirement**: RM-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [x] Uses `spawn` with an argument vector, never `exec` - a storage key containing a quote must not reach a shell
- [x] A command exiting 0 resolves with its stdout and stderr
- [x] A command exiting non-zero rejects with an error carrying the exit code and the captured stderr
- [x] A command that outlives `timeoutMs` is sent `SIGTERM` then `SIGKILL`, and the rejection names the timeout as the cause
- [x] Tested against real short-lived commands, not a mocked `child_process`
- [x] Quick gate passes: `npm test`
- [x] Test count: at least 5 new tests pass (no silent deletions)

**Status**: ✅ Complete
**Tests**: unit
**Gate**: quick

---

### T3: Add the callback-scoped temp workspace

**What**: A per-job directory handed to a callback and removed on every exit path.
**Where**: `src/media/temp-workspace.ts`
**Depends on**: None
**Reuses**: The `runInTransaction` shape from the Catalog's unit of work - the resource is handed **to** the callback so no exit path can skip the release
**Requirement**: RM-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [x] `withWorkspace` creates a directory named by `processingRequestId` and `attemptId` under the system temp directory
- [x] The directory and its contents are removed after the callback returns
- [x] The directory is removed when the callback throws, and the original error propagates unchanged
- [x] A failure to remove the directory is logged and does not change the callback's outcome
- [x] Tested against the real filesystem, asserting the directory is gone in both cases
- [x] Quick gate passes: `npm test`
- [x] Test count: at least 4 new tests pass (no silent deletions)

**Status**: ✅ Complete
**Tests**: unit
**Gate**: quick

---

### T4: Fail readiness when the binaries are missing

**What**: A health indicator that probes for FFmpeg and FFprobe once at bootstrap and reports readiness from the result.
**Where**: `src/health/ffmpeg-availability.indicator.ts`
**Depends on**: T1, T2
**Reuses**: The indicator shape already in `src/health/`, and the health controller's existing readiness composition
**Requirement**: RM-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [x] Readiness is false when either binary is absent, and true when both answer
- [x] The probe runs once at bootstrap rather than per health request
- [x] Liveness does not depend on it
- [x] The health endpoint reports the media capability, so an operator sees the cause without reading logs
- [x] Full gate passes: `npm test && npm run test:e2e`
- [x] Test count: at least 3 new tests pass (no silent deletions)

**Status**: ✅ Complete
**Tests**: e2e
**Gate**: full

---

### Phase 2: Object storage behind a port

### T5: Declare the object storage port and its in-memory adapter

**What**: The port plus the in-memory implementation the unit tests drive.
**Where**: `src/storage/object-storage.interface.ts`
**Depends on**: None
**Reuses**: The port-and-token convention from `video-validator.interface.ts`
**Requirement**: RM-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] `head` returns `undefined` for an absent key and never throws for absence
- [ ] `download` and `upload` are declared in terms of local paths, so adapters own all transfer detail
- [ ] The in-memory adapter satisfies the port with a type that forces every member - never `Partial`, which once let a missing method compile and fail only at runtime
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 4 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T6: Implement the port against S3

**What**: The `@aws-sdk/client-s3` adapter, with path-style addressing and an endpoint from configuration.
**Where**: `src/storage/s3-object-storage.ts`
**Depends on**: T5
**Reuses**: `ObjectStorage` port from T5
**Requirement**: RM-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] `forcePathStyle: true` and the endpoint, bucket and credentials all come from configuration - no provider name appears above this file (AD-005)
- [ ] A `NotFound` / `404` from `head` becomes `undefined` rather than a thrown error
- [ ] `download` streams to a local path without buffering the whole object in memory
- [ ] An integration test round-trips upload, head and download against a real endpoint, and skips by its own guard when `STORAGE_ENDPOINT` is unset
- [ ] Full gate passes: `npm test && npm run test:e2e`
- [ ] Test count: at least 4 new tests pass (no silent deletions)

**Tests**: integration
**Gate**: full

---

### T7: Select the adapter in the composition root, and assert the selection

**What**: Wire storage into the module graph with a factory, and add the e2e test that asserts which implementation the root actually selects.
**Where**: `src/app.module.ts`
**Depends on**: T5, T6
**Reuses**: The token-plus-factory shape in `messaging.module.ts`
**Requirement**: RM-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] With credentials configured the root selects the S3 adapter; without them it selects the in-memory one
- [ ] The readiness response names which storage adapter is in use, so a stack running on the in-memory adapter is visible rather than silently inert
- [ ] A composition e2e test asserts both selections - this exists because the Catalog once shipped a complete persistence layer that `app.module.ts` never referenced, with 36 tests green and zero tables in the running stack
- [ ] Full gate passes: `npm test && npm run test:e2e`
- [ ] Test count: at least 3 new tests pass (no silent deletions)

**Tests**: e2e
**Gate**: full

---

### Phase 3: Validation that opens the file

### T8: Add the FFprobe wrapper

**What**: A probe that reports container family, duration and whether a video stream exists.
**Where**: `src/media/ffprobe-probe.ts`
**Depends on**: T2
**Reuses**: `ChildProcessRunner` from T2
**Requirement**: RM-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Invokes `ffprobe -v error -print_format json -show_format -show_streams <path>` and parses `format.format_name`, `format.duration` and `streams[].codec_type`
- [ ] Returns `{ readable: false }` when FFprobe exits non-zero, times out, or emits output that is not JSON
- [ ] An MP4 container with no video stream yields `hasVideoStream: false` rather than being treated as readable
- [ ] A missing duration is absent rather than defaulted to zero, so the caller decides what that means
- [ ] The argument vector is asserted, not only the parsed result
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 6 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T9: Implement the validator and its code mapping

**What**: The `VideoValidator` implementation applying the size, duration and container rules and mapping every rejection to a safe code.
**Where**: `src/validation/ffprobe-video-validator.ts`
**Depends on**: T3, T5, T8
**Reuses**: `VideoValidator` port and the `FailureCode` union already defined in `video-validator.interface.ts`
**Requirement**: RM-07, RM-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Checks the reported size from `head` **before** downloading, so an oversized object is rejected without transfer
- [ ] An absent source object yields `FORMATO_INVALIDO` and the probe is not retried
- [ ] Duration above 600 s yields `DURACAO_EXCEDIDA`; size above 500 MB yields `FORMATO_INVALIDO`; a container outside the MP4/MOV family, a missing video stream, an unreadable file and a probe timeout all yield `FORMATO_INVALIDO`
- [ ] A zero-length object yields `FORMATO_INVALIDO`
- [ ] Exactly one outcome is produced per call, and the temp workspace is gone afterwards on every path
- [ ] Tests map 1:1 to the RM-07 and RM-08 acceptance criteria, and cover every listed edge case
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 10 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T10: Select the real validator in the validation module

**What**: Register the FFprobe validator as the production implementation, keeping the accept-all one as a test double only.
**Where**: `src/validation/validation.module.ts`
**Depends on**: T7, T9
**Reuses**: The existing `VIDEO_VALIDATOR` token binding
**Requirement**: RM-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] The production factory binds `VIDEO_VALIDATOR` to the FFprobe implementation
- [ ] `AcceptAllVideoValidator` remains in the tree as a test double and is never bound by the production factory
- [ ] The composition e2e test from T7 is extended to assert which validator the root selects
- [ ] An e2e test drives a real readable MP4 to `VideoAccepted` and a non-video file to `VideoRejected` with `FORMATO_INVALIDO`
- [ ] Full gate passes: `npm test && npm run test:e2e`
- [ ] Test count: at least 4 new tests pass (no silent deletions)

**Tests**: e2e
**Gate**: full

---

### Phase 4: Extraction and packaging

### T11: Add the frame extractor

**What**: An adapter writing one JPEG per second of video into a directory, with an explicit thread count.
**Where**: `src/media/ffmpeg-frame-extractor.ts`
**Depends on**: T2
**Reuses**: `ChildProcessRunner` from T2
**Requirement**: RM-10, RM-15

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Invokes `ffmpeg -nostdin -v error -i <src> -vf fps=1 -threads <N> <dir>/frame-%05d.jpg`
- [ ] The thread count comes from configuration and defaults to 1 - host core detection is never used (AD-006)
- [ ] The returned frame list is read back from the directory and sorted, so it reflects what FFmpeg wrote rather than what was expected
- [ ] A non-zero exit or a timeout rejects, and no partial frame list is returned
- [ ] The **argument vector** is asserted, including `-threads` and its value - a dropped flag is invisible in the produced frames, which is why AD-006 had to state it
- [ ] A real short video produces the expected number of frames
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 6 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T12: Add the ZIP builder

**What**: Pack a list of files into one uncompressed archive and report the entry count written.
**Where**: `src/media/zip-builder.ts`
**Depends on**: None
**Reuses**: Nothing; adds `archiver@8.0.0` (Node >= 18, satisfied by the image's Node 22)
**Requirement**: RM-11

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Created with `{ zlib: { level: 0 } }` - JPEG does not compress, so any level above zero is CPU spent for nothing
- [ ] Resolves with the entry count actually written, so the caller can assert that what went in came out
- [ ] Entries carry the frame file names, and listing them in lexical order yields temporal order
- [ ] An empty input list rejects rather than producing a valid empty archive - an empty archive is indistinguishable from a stub's output
- [ ] A write failure rejects and leaves no archive at the destination
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 5 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T13: Implement the media frame packager

**What**: The `FramePackager` implementation turning a queued job into exactly one stored archive, idempotently.
**Where**: `src/processing/media-frame-packager.ts`
**Depends on**: T3, T5, T11, T12
**Reuses**: `FramePackager` port, and the key derivation from `DeterministicFramePackager` so the real packager produces the **same** key
**Requirement**: RM-09, RM-11, RM-13, RM-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Begins with `head` on the deterministic key; an archive already there returns the key without extracting and without storing a second object
- [ ] On a first attempt: downloads the source, extracts frames, builds the archive, uploads it, and returns the key
- [ ] The upload is the last step, so a failure at any earlier stage leaves no object at all rather than a partial one
- [ ] `ProcessingCompleted` is only reachable after the upload has been confirmed
- [ ] A failure at each stage - download, extract, zip, upload - propagates, and the temp workspace is gone afterwards in every case
- [ ] The archive's entry count is asserted against the extracted frame count before upload
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 9 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T14: Select the real packager in the processing module

**What**: Register the media packager as the production implementation, keeping the deterministic one as a test double.
**Where**: `src/processing/processing.module.ts`
**Depends on**: T7, T13
**Reuses**: The existing `FRAME_PACKAGER` token binding
**Requirement**: RM-11

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] The production factory binds `FRAME_PACKAGER` to the media implementation
- [ ] `DeterministicFramePackager` remains as a test double and as the single definition of the key format, and is never bound by the production factory
- [ ] The composition e2e test is extended to assert which packager the root selects
- [ ] An e2e test drives a real MP4 from `ProcessingQueued` to `ProcessingCompleted`, and the stored archive holds one entry per second of video
- [ ] `ProcessingStarted` is asserted to be published before extraction begins
- [ ] Full gate passes: `npm test && npm run test:e2e`
- [ ] Test count: at least 4 new tests pass (no silent deletions)

**Tests**: e2e
**Gate**: full

---

### Phase 5: Concurrency, failure and redelivery

### T15: Bound in-flight work per queue

**What**: Apply a configured `prefetchCount` to every consumed queue, replacing the transport's unlimited default.
**Where**: `src/main.ts`
**Depends on**: None
**Reuses**: The existing `connectMicroservice` options blocks
**Requirement**: RM-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Both consumed queues receive a finite `prefetchCount` from configuration, defaulting to 20 for validation and 1 for processing
- [ ] No queue is consumed with an unlimited prefetch - Nest's default of `0` means unlimited, which hides queue depth from the autoscaler S8 will read
- [ ] The documented defaults are applied when configuration is absent, rather than falling through to the transport default
- [ ] `broker-topology.spec.ts` still passes: `prefetchCount` is a consumer setting on the channel, not a queue argument, so it must not have become a topology change (AD-011)
- [ ] Full gate passes: `npm test && npm run test:e2e`
- [ ] Test count: at least 3 new tests pass (no silent deletions)

**Tests**: e2e
**Gate**: full

---

### T16: Make the failure path terminal and clean

**What**: Publish `ProcessingFailed` with `PROCESSAMENTO_FALHOU` for every packaging failure, with no second business attempt.
**Where**: `src/processing/processing.consumer.ts`
**Depends on**: T13
**Reuses**: The consumer's existing publication paths for both outcomes
**Requirement**: RM-12, RM-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Any packager failure yields exactly one `ProcessingFailed` carrying `PROCESSAMENTO_FALHOU`
- [ ] No second business attempt is started for a failed job
- [ ] Exactly one of `ProcessingCompleted` or `ProcessingFailed` is published per job, on every path
- [ ] A storage failure and an extraction failure are both covered, and neither leaves a stored object
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 5 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T17: Prove redelivery and cleanup end to end

**What**: An e2e suite asserting that a redelivered job costs nothing and that no job leaves a temporary directory behind.
**Where**: `test/real-media.e2e-spec.ts`
**Depends on**: T14, T15, T16, T18, T19
**Reuses**: The existing e2e harness and the in-memory storage adapter as the observation point
**Requirement**: RM-13, RM-16, RM-18

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] Publishing the same `ProcessingQueued` twice yields one stored object, one extraction, and two `ProcessingCompleted` events identical down to their `eventId`
- [ ] A redelivered validation job yields the same outcome it yielded the first time
- [ ] The system temp directory holds no leftover job directory after a successful job, a failed job, and a job killed by a timeout
- [ ] The suite fails if the packager is replaced by one that stores nothing - verified by actually making that substitution, not by assuming
- [ ] Build gate passes: `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build`
- [ ] Test count: at least 6 new tests pass (no silent deletions)

**Tests**: e2e
**Gate**: build

---

### T18: Derive outcome event ids from the consumed event

**What**: Replace `randomUUID()` in both consumers with an `eventId` derived from the consumed event's id and the outcome type, so a redelivered job republishes under the same id.
**Where**: `src/messaging/outcome-event-id.ts`, `src/validation/validation.consumer.ts`, `src/processing/processing.consumer.ts`
**Depends on**: None
**Reuses**: The consumers' existing publication paths; `node:crypto` for the hash
**Requirement**: RM-18

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] `outcomeEventId` returns a v5-formatted UUID, the same for the same inputs and different for a different consumed id or a different outcome
- [ ] No `randomUUID()` remains on any outcome publication path in either consumer
- [ ] `ProcessingStarted` and `ProcessingCompleted` for the same job carry different ids
- [ ] Consumer tests assert that consuming the same message twice publishes the same `eventId` both times, for every outcome type
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 5 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

### T19: Pause before requeue, and dead-letter what cannot succeed

**What**: Replace the inline `nack` in both consumers with `settleFailedMessage`: a message that is itself wrong is nacked without requeue (dead-lettered by the broker policy), anything else is requeued only after `RABBITMQ_RETRY_BACKOFF_MS`.
**Where**: `src/messaging/settle-failed-message.ts`, `src/validation/validation.consumer.ts`, `src/processing/processing.consumer.ts`
**Depends on**: None
**Reuses**: The Catalog's `settleFailedMessage` (`processing-catalog/src/infrastructure/rabbitmq/settle-failed-message.ts`) - same variable, same default, same classification rule
**Requirement**: RM-20

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:
- [ ] `ValidationRejectedError`, `ProcessingRejectedError` and `SyntaxError` are nacked without requeue, with no pause
- [ ] Any other error is requeued only after the configured backoff (default 1000 ms), asserted with fake timers: nothing at `backoff - 1`, the requeue at `backoff`
- [ ] An unset or invalid `RABBITMQ_RETRY_BACKOFF_MS` falls back to the default
- [ ] No inline `nack(..., requeue)` decision remains in either consumer; both still rethrow after settling, so Nest's own handling is unchanged
- [ ] **Established, not assumed**: what Nest's RMQ transport does with a body that is not JSON, before any handler runs. If it requeues, the gap is recorded in this task's evidence and in the gap analysis rather than papered over
- [ ] Quick gate passes: `npm test`
- [ ] Test count: at least 6 new tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

---

## Phase Execution Map

Phases run in sequence; tasks within a phase run in order.

```
Phase 1 (T1 T2 T3 T4) then Phase 2 (T5 T6 T7) then Phase 3 (T8 T9 T10) then Phase 4 (T11 T12 T13 T14) then Phase 5 (T15 T16 T18 T19 T17)
```

Execution is strictly sequential - there is no intra-phase parallelism. T18 was added after the S1–S3 verification of 2026-09-24 and T19 after `fix/pre-s4-hardening` merged (2026-09-25, AD-012); both run before T17, whose build gate covers them.

19 tasks pack into three task-budgeted batches at ~7 tasks per worker, cutting only on phase boundaries: **Phase 1 + Phase 2** (7), **Phase 3 + Phase 4** (7), **Phase 5** (5). Because that is more than one batch, Execute must present the sub-agent offer before dispatching, and the Verifier runs automatically after T17.

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1: FFmpeg in the image | 1 file | ✅ Granular |
| T2: Child-process runner | 1 class | ✅ Granular |
| T3: Temp workspace | 1 class | ✅ Granular |
| T4: Availability indicator | 1 indicator + its readiness binding | ✅ Granular (cohesive - the indicator is unverifiable unwired) |
| T5: Storage port + in-memory adapter | 1 port + its double, one concept | ⚠️ OK - cohesive; the double is how the port is tested |
| T6: S3 adapter | 1 class | ✅ Granular |
| T7: Composition wiring + selection test | 1 file | ✅ Granular |
| T8: FFprobe wrapper | 1 class | ✅ Granular |
| T9: Validator implementation | 1 class | ✅ Granular |
| T10: Validation module binding | 1 file | ✅ Granular |
| T11: Frame extractor | 1 class | ✅ Granular |
| T12: ZIP builder | 1 class | ✅ Granular |
| T13: Media frame packager | 1 class | ✅ Granular |
| T14: Processing module binding | 1 file | ✅ Granular |
| T15: Prefetch per queue | 1 file | ✅ Granular |
| T16: Terminal failure path | 1 file | ✅ Granular |
| T17: Redelivery and cleanup e2e | 1 test file | ✅ Granular |
| T18: Derived outcome event ids | 1 function + its two call sites | ✅ Granular (cohesive - the function is unverifiable unused) |
| T19: Retry pause and failure classification | 1 function + its two call sites | ✅ Granular (cohesive - the function is unverifiable unused) |

---

## Diagram-Definition Cross-Check

Parity is required **within** a phase. A dependency reaching back into an earlier phase is validated by the forward-phase check and needs no arrow.

| Task | Depends On (task body) | Diagram Shows (within phase) | Status |
| --- | --- | --- | --- |
| T1 | None | — | ✅ Match |
| T2 | None | — | ✅ Match |
| T3 | None | — | ✅ Match |
| T4 | T1, T2 | T1 → T4, T2 → T4 | ✅ Match |
| T5 | None | — | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |
| T7 | T5, T6 | T5 → T7, T6 → T7 | ✅ Match |
| T8 | T2 (phase 1) | — cross-phase | ✅ Match |
| T9 | T3 (ph1), T5 (ph2), T8 | T8 → T9 | ✅ Match |
| T10 | T7 (ph2), T9 | T9 → T10 | ✅ Match |
| T11 | T2 (ph1) | — cross-phase | ✅ Match |
| T12 | None | — | ✅ Match |
| T13 | T3 (ph1), T5 (ph2), T11, T12 | T11 → T13, T12 → T13 | ✅ Match |
| T14 | T7 (ph2), T13 | T13 → T14 | ✅ Match |
| T15 | None | — | ✅ Match |
| T16 | T13 (ph4) | — cross-phase | ✅ Match |
| T17 | T14 (ph4), T15, T16, T18, T19 | T15 → T17, T16 → T17, T18 → T17, T19 → T17 | ✅ Match |
| T18 | None | — | ✅ Match |
| T19 | None | — | ✅ Match |

No task depends on a later phase.

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Dockerfile | none | none | ✅ OK |
| T2 | Process primitives | unit | unit | ✅ OK |
| T3 | Process primitives | unit | unit | ✅ OK |
| T4 | Health indicator + wiring | e2e | e2e | ✅ OK |
| T5 | Storage port and in-memory adapter | unit | unit | ✅ OK |
| T6 | Storage S3 adapter | integration | integration | ✅ OK |
| T7 | Composition root | e2e | e2e | ✅ OK |
| T8 | Media adapters | unit | unit | ✅ OK |
| T9 | Validation implementation | unit | unit | ✅ OK |
| T10 | Module wiring | e2e | e2e | ✅ OK |
| T11 | Media adapters | unit | unit | ✅ OK |
| T12 | Media adapters | unit | unit | ✅ OK |
| T13 | Frame packager | unit | unit | ✅ OK |
| T14 | Module wiring | e2e | e2e | ✅ OK |
| T15 | Consumers and module wiring | e2e | e2e | ✅ OK |
| T16 | Consumers | unit | unit | ✅ OK |
| T17 | Consumers and module wiring | e2e | e2e | ✅ OK |
| T18 | Consumers | unit | unit | ✅ OK |
| T19 | Consumers | unit | unit | ✅ OK |

T1 is the only `Tests: none`, and the matrix says `none` for the Dockerfile layer: it declares environment and carries no branching. Its correctness is proved by T4, which fails readiness when the binaries are absent.
