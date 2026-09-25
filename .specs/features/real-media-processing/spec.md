# Real Media Processing Specification — worker

## Problem Statement

This service reports that it validated and processed a video without doing either. `AcceptAllVideoValidator` returns `{ accepted: true }` without opening the file, and `DeterministicFramePackager` returns `local/<id>/<attempt>/frames.zip` without producing an archive. Every event downstream is real, every status transition is real, and the ZIP the user is promised does not exist. This slice makes the two ports do what their names claim: FFprobe decides whether a file may be processed, FFmpeg extracts one frame per second, and the resulting archive is stored where the Catalog says it is.

It is also where AD-006's concurrency model stops being a decision and becomes configuration. Today `prefetchCount` is unset on both queues, and Nest's default of `0` means unlimited: one replica drains the whole queue, and because unacknowledged messages disappear from queue depth, it blinds the autoscaler that S8 will rely on.

## Goals

- [ ] A readable MP4 or MOV within 500 MB and 10 minutes is accepted; anything else is rejected with the correct safe failure code
- [ ] A real ZIP containing one frame per second of video is stored at a key derived from `processingRequestId` and `attemptId`
- [ ] A redelivered job produces no second attempt and no second stored object
- [ ] In-flight work is bounded per queue, so a replica cannot hide the queue depth the autoscaler reads
- [ ] FFmpeg receives an explicit thread count instead of detecting the host's cores
- [ ] No job leaves a temporary file behind, on any path out

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| --- | --- |
| Presigned upload and download URLs | S6. This service reads and writes by key with its own credentials |
| Object storage, its bucket and retention | `fiap-x-platform` owns the topology (RM-01 to RM-03) |
| Deciding the request lifecycle | The Catalog owns status transitions. This service publishes facts about work it performed |
| Owner-scoped authorization | S5 introduces the authenticated owner. This service acts on jobs it is handed |
| Horizontal autoscaling by queue depth | S8 and S9a. This slice makes the depth readable by bounding prefetch; it does not scale anything |
| Configurable frame interval | `docs/foudation.md` fixes 1 frame per second. A knob with one legal value is a knob nobody should have |
| Resuming a partially extracted job | A failed attempt is republished as a new attempt with a new `attemptId`. Resumption would need per-frame state that nothing asks for |
| Transcoding, thumbnails, or any other derived media | The product delivers frames as a ZIP. Nothing else is requested |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Whether the source is streamed or downloaded before probing | Downloaded to a temporary path, then probed and extracted from disk | FFprobe needs to seek, and a 500 MB ceiling makes local disk affordable. Streaming would trade a bounded disk cost for an unbounded failure surface | n |
| Which value the size limit is checked against | The object's reported size in storage, before download | Downloading 4 GB to discover it exceeds 500 MB spends the cost the limit exists to avoid | n |
| What "readable MP4 or MOV" means concretely | FFprobe reports a container format in `mp4,mov,m4a,3gp,3g2,mj2` **and** at least one video stream | A file can carry an MP4 extension and no video stream. The container alone is not evidence that frames exist | n |
| Which code an oversized file maps to | `FORMATO_INVALIDO` | **The closed vocabulary has no code for size.** `docs/foudation.md` states a 500 MB limit and separately fixes the three safe codes, and none of them means "too large". `DURACAO_EXCEDIDA` would state a false reason for a short, huge file; `PROCESSAMENTO_FALHOU` would imply our fault. `FORMATO_INVALIDO` is imprecise but never false: the file as submitted cannot be processed. Worth raising as a `foudation.md` gap rather than hiding in code | n |
| Which code an unreadable file maps to | `FORMATO_INVALIDO` | The closed vocabulary in `video-validator.interface.ts` has no separate code for corruption, and the user-facing meaning is the same: this file cannot be processed as a video | n |
| Whether a probe timeout rejects or fails | Rejects with `FORMATO_INVALIDO` | A file FFprobe cannot read within the timeout is not processable. Treating it as an infrastructure failure would requeue it forever against a file that will never parse | n |
| `prefetchCount` for validation | 20 | FFprobe on a downloaded file is cheap and mostly I/O. A high bound keeps a replica busy without hiding meaningful depth | n |
| `prefetchCount` for processing | 1 | Extraction saturates the CPU allotment it is given. Holding a second job unacknowledged would remove it from queue depth while doing nothing with it — the exact blindness this requirement exists to remove | n |
| `FFMPEG_THREADS` default when unset | 1 | An explicit, safe value. Defaulting to host detection is the behaviour AD-006 rejects, and defaulting to a guess would be worse than one thread | n |
| Where temporary files live | A per-job directory under the system temp directory, named by `processingRequestId` and `attemptId` | Names the owner of a leaked directory, and a per-job root makes cleanup one removal rather than a list | n |
| How idempotency is decided on redelivery | By the existence of an object at the deterministic key | The key is already derived from `processingRequestId` and `attemptId`, so a technical redelivery addresses the same object. Storage is the one place that survives a restart, which local state does not | n |
| Whether ZIP entries are compressed | Stored without compression | JPEG frames do not compress meaningfully, so the CPU spent is spent for nothing | n |
| Frame image format and naming | JPEG, zero-padded sequential names | Zero padding keeps lexical order equal to temporal order, which is what a consumer extracting the archive will assume | n |
| How an outcome event gets its `eventId` | Derived deterministically (UUIDv5) from the consumed event's `eventId` and the outcome's type, instead of `randomUUID()` | Today every redelivery republishes its outcome under a fresh id, so the Catalog's `eventId` deduplication never recognises it: a republished `ProcessingCompleted` reaches a `COMPLETED` request as a new event, fails the domain guard and is dead-lettered. A derived id turns the republish into a duplicate the Catalog already absorbs. Found by the S1–S3 verification of 2026-09-24 | n |
| What happens when storage is unreachable during **validation** | The job is requeued after a pause; no `VideoRejected` is published | Rejecting would tell the user their file is invalid when the fault is ours. Processing fails terminally (P3) because a business attempt already exists; validation has none yet. The broker's delivery limit does **not** bound this retry: RabbitMQ 4 does not count an explicit requeue against it (AD-012), so the pause of RM-20 is what keeps the loop from spinning | n |
| How a failure is classified for settlement | A `ValidationRejectedError`/`ProcessingRejectedError` (the message itself is wrong) is nacked without requeue and dead-lettered; anything else is requeued after `RABBITMQ_RETRY_BACKOFF_MS` (default 1000) | Mirrors the Catalog's `settleFailedMessage` (AD-012), so both services behave the same when a dependency is down. Today the Worker requeues immediately, which spins a message against a dead dependency as fast as the broker can redeliver it | n |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Validation that opens the file ⭐ MVP

**User Story**: As the request owner, I want my video actually inspected so that a request that cannot be processed fails immediately with a reason instead of being accepted and failing later.

**Why P1**: The rejection path is fully wired and never taken. Until validation inspects a real file, `FORMATO_INVALIDO` and `DURACAO_EXCEDIDA` are codes no input can produce.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN the Worker consumes a validation job THEN it SHALL probe the source object and SHALL publish `VideoAccepted` only if the probe reports a container in the MP4/MOV family with at least one video stream, a duration of at most 600 seconds, and a size of at most 500 MB.
2. IF the probe reports a duration above 600 seconds THEN the Worker SHALL publish `VideoRejected` with `DURACAO_EXCEDIDA`.
3. IF the object's size exceeds 500 MB THEN the Worker SHALL publish `VideoRejected` with `FORMATO_INVALIDO`.
4. IF the probe reports a container outside the MP4/MOV family, reports no video stream, or cannot read the file THEN the Worker SHALL publish `VideoRejected` with `FORMATO_INVALIDO`.
5. IF the source object does not exist in storage THEN the Worker SHALL publish `VideoRejected` with `FORMATO_INVALIDO` and SHALL NOT retry the probe.
6. The Worker SHALL check the object's reported size before downloading it, so that an oversized file is rejected without being transferred.
7. WHILE a validation job is in flight the Worker SHALL publish exactly one of `VideoAccepted` or `VideoRejected` for it.

**Independent Test**: Feed a real 8-second MP4 and see `VideoAccepted`; feed a text file renamed to `.mp4` and see `VideoRejected` with `FORMATO_INVALIDO`; feed an 11-minute MP4 and see `DURACAO_EXCEDIDA`.

---

### P2: Extraction that produces a ZIP ⭐ MVP

**User Story**: As the request owner, I want a ZIP containing one frame per second of my video so that I receive the artefact the product promises.

**Why P2**: It is the product. Everything else in the system exists to deliver this file.

**Acceptance Criteria**:

1. WHEN the Worker consumes a processing job THEN it SHALL publish `ProcessingStarted` before beginning extraction.
2. WHEN extraction runs THEN the Worker SHALL extract one frame per second of video.
3. WHEN extraction completes THEN the Worker SHALL store exactly one ZIP archive at the key derived from `processingRequestId` and `attemptId`, and SHALL publish `ProcessingCompleted` carrying that key.
4. WHEN the archive is produced THEN it SHALL contain one entry per extracted frame and no other entries.
5. WHEN the archive entries are listed in lexical order THEN they SHALL be in the same order as the frames in the video.
6. The Worker SHALL publish `ProcessingCompleted` only after the storage write has been confirmed, so that the key it announces is readable.
7. WHEN FFmpeg is invoked THEN the Worker SHALL pass an explicit thread count taken from configuration and SHALL NOT rely on host core detection.

**Independent Test**: Process an 8-second MP4 and download the stored archive; it opens, holds 8 entries, and their names sort into temporal order.

---

### P3: Failure that is honest and terminal

**User Story**: As the request owner, I want a job that cannot be completed to end as failed with a safe reason so that I am not left waiting on work nobody is doing.

**Why P3**: Without it, an extraction failure either retries forever or vanishes. Both look identical to the user: a request that never finishes.

**Acceptance Criteria**:

1. IF extraction fails, the archive cannot be built, or the storage write fails THEN the Worker SHALL publish `ProcessingFailed` with `PROCESSAMENTO_FALHOU`.
2. IF a job fails THEN the Worker SHALL NOT start a second business attempt for it.
3. WHEN a job ends, whether it completed or failed THEN the Worker SHALL remove its temporary directory.
4. IF removing the temporary directory fails THEN the Worker SHALL log the path and SHALL NOT change the outcome it already published.
5. IF FFmpeg or FFprobe is absent from the image THEN the Worker SHALL fail its readiness check at startup rather than failing each job individually.
6. WHILE a processing job is in flight the Worker SHALL publish exactly one of `ProcessingCompleted` or `ProcessingFailed` for it.

7. IF handling a job throws an error that is not a rejection of the message itself THEN the Worker SHALL wait the configured retry backoff before requeueing it, and SHALL NOT requeue immediately.
8. IF a job is rejected because the message itself is invalid THEN the Worker SHALL nack it without requeue, so that the broker's dead-letter policy routes it to `<queue>.dlq`.

**Independent Test**: Point a job at an object that is a valid MP4 header followed by garbage, and see `ProcessingFailed` with `PROCESSAMENTO_FALHOU`, no archive stored, and no temporary directory left on disk. Separately, make storage unreachable during validation and confirm the job is requeued no faster than once per backoff interval.

---

### P4: A redelivery costs nothing

**User Story**: As the operator, I want a redelivered job to be absorbed so that a broker retry does not produce a second archive or a second attempt.

**Why P4**: Delivery is at-least-once by design — AD-010 made that explicit when the outbox replaced direct publication. A redelivery is expected traffic, not an anomaly.

**Acceptance Criteria**:

1. WHEN a processing job is redelivered and an archive already exists at its deterministic key THEN the Worker SHALL republish `ProcessingCompleted` with that key and SHALL NOT extract again.
2. WHEN a job is redelivered THEN the Worker SHALL NOT store a second object.
3. WHEN a validation job is redelivered THEN the Worker SHALL publish the same outcome it published the first time.
4. WHEN the Worker publishes an outcome event THEN its `eventId` SHALL be derived deterministically from the consumed event's `eventId` and the outcome type, so that a redelivered job republishes under the same `eventId`.
5. WHEN a republished outcome reaches the Catalog THEN it SHALL be absorbed by the Catalog's `eventId` deduplication and SHALL NOT be dead-lettered.

**Independent Test**: Publish the same `ProcessingQueued` event twice and confirm one stored object, one extraction, and two `ProcessingCompleted` events identical down to their `eventId`.

---

### P5: Bounded work in flight

**User Story**: As the operator, I want each queue to have a configured prefetch so that queue depth reflects waiting work and the autoscaler S8 adds can read it.

**Why P5**: Nest's default prefetch of `0` is unlimited. One replica acknowledges nothing and holds everything, so the queue looks empty while the work is untouched — and the autoscaler scales down exactly when it should scale up.

**Acceptance Criteria**:

1. WHEN the Worker starts THEN it SHALL apply a configured `prefetchCount` to each queue it consumes.
2. The Worker SHALL NOT consume any queue with an unlimited prefetch.
3. WHERE a prefetch value is absent from configuration the Worker SHALL apply a documented default rather than the transport's unlimited default.
4. WHILE more jobs are queued than the configured prefetch allows the Worker SHALL leave the excess unacknowledged in the queue, so that queue depth remains a measure of pending work.

**Independent Test**: Queue more jobs than the processing prefetch permits and confirm the broker still reports the excess as ready rather than unacknowledged.

---

## Edge Cases

- WHEN a video's duration is not a whole number of seconds THEN the Worker SHALL produce the number of frames FFmpeg emits at 1 frame per second, and the archive entry count SHALL match it.
- IF a video is shorter than one second THEN the Worker SHALL still produce at least one frame and SHALL complete rather than fail.
- IF the source object exists but has zero length THEN the Worker SHALL publish `VideoRejected` with `FORMATO_INVALIDO`.
- IF object storage is unreachable while reading the source for a processing job THEN the Worker SHALL publish `ProcessingFailed` with `PROCESSAMENTO_FALHOU` rather than leaving the job silently unacknowledged.
- IF object storage is unreachable during a validation job THEN the Worker SHALL NOT publish `VideoRejected` and SHALL requeue the job after the retry backoff (RM-20), because the fault is not the user's file.
- IF a delivered body is not valid JSON THEN the Worker SHALL NOT requeue it indefinitely: it SHALL be dead-lettered. Nest's RMQ transport parses the body before any handler runs, so where that parse fails is the first thing T19 establishes.
- IF FFmpeg exits non-zero after writing some frames THEN the Worker SHALL treat the job as failed and SHALL NOT store a partial archive.
- IF the FFmpeg process exceeds its configured timeout THEN the Worker SHALL terminate it, publish `ProcessingFailed` with `PROCESSAMENTO_FALHOU`, and remove the temporary directory.
- WHEN the Worker is shut down while a job is in flight THEN it SHALL NOT acknowledge that job, so that another replica receives it.
- IF the disk fills during extraction THEN the Worker SHALL publish `ProcessingFailed` with `PROCESSAMENTO_FALHOU` and SHALL remove whatever it wrote.

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

`RM-` is shared with `fiap-x-platform`, which owns `RM-01` through `RM-06` — the object storage, its retention, the seeded fixture, the CPU-limit pairing and the smoke assertion this service's work is proved by.

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| RM-07 | P1: Validation that opens the file | Execute (T8) | Implementing |
| RM-08 | P1: Validation that opens the file | Design | Pending |
| RM-09 | P2: Extraction that produces a ZIP | Execute (T5, T6, T7) | Implementing |
| RM-10 | P2: Extraction that produces a ZIP | Design | Pending |
| RM-11 | P2: Extraction that produces a ZIP | Design | Pending |
| RM-12 | P3: Failure that is honest and terminal | Execute (T2) | Implementing |
| RM-13 | P4: A redelivery costs nothing | Design | Pending |
| RM-14 | P5: Bounded work in flight | Design | Pending |
| RM-15 | P2: Extraction that produces a ZIP | Design | Pending |
| RM-16 | P3: Failure that is honest and terminal | Execute (T3) | Implementing |
| RM-17 | P3: Failure that is honest and terminal | Execute (T1, T4) | Implementing |
| RM-18 | P4: A redelivery costs nothing | Design | Pending |
| RM-20 | P3: Failure that is honest and terminal | Design | Pending |

`RM-19` belongs to `fiap-x-platform` (the smoke's rejection path), which is why this service's range skips it.

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 13 total, 13 mapped to tasks, 0 unmapped

---

## Success Criteria

How we know the feature is successful:

- [ ] A real 8-second MP4 yields a stored ZIP with 8 entries, and the Catalog reports `COMPLETED` with that key
- [ ] A text file renamed `.mp4` yields `FAILED` with `FORMATO_INVALIDO`; an 11-minute video yields `DURACAO_EXCEDIDA`
- [ ] Publishing the same `ProcessingQueued` twice leaves one stored object and one extraction, and the Catalog's dead-letter queue stays empty
- [ ] No temporary directory remains after any job, including one killed by a timeout
- [ ] Both queues report a finite prefetch, and queued work beyond it stays `ready` rather than `unacked`
- [ ] The FFmpeg command line carries an explicit `-threads` value that matches the container's CPU limit
- [ ] With storage unreachable, a validation job is retried at most once per backoff interval, and an invalid message lands in `<queue>.dlq` on its first delivery

---

## Dependencies

RM-01 to RM-06 in `fiap-x-platform` provide the bucket, the seeded source video and the smoke that proves the archive. This service cannot be demonstrated end to end before they exist, though every story above is testable in isolation against a storage double.

S3 (`durable-persistence`) is merged, and this branch was rebased onto it on 2026-09-24: the Catalog it publishes to is the durable one, and the redelivery behaviour in P4 is only meaningful because AD-010 made delivery at-least-once.

Three findings of the S1–S3 verification (2026-09-24) that bore on this slice were **resolved before it started**, by `fix/pre-s4-hardening` (merged 2026-09-25: `fiap-x-platform#5`, `processing-catalog#6`, `notification-service#6`). This branch was rebased onto that merge the same day.

| Finding | Resolution | What this slice can now rely on |
| --- | --- | --- |
| V3 — the Catalog could handle `ProcessingCompleted` before `ProcessingStarted` commits and dead-letter it | AD-013: lifecycle events are applied under a row lock, and the Catalog accepts completion from `QUEUED`, ignores a late or repeated start, and absorbs a completion that restates the stored key | A fast extraction cannot strand a request in `PROCESSING`, so a red platform smoke points at the media path. A republished `ProcessingCompleted` is absorbed even before RM-18 lands |
| V2 — the dead-letter policy did not match `video-validation` or `processing` | AD-012: the broker declares both queues and their `.dlq` as quorum queues, and the policy matches them with `delivery-limit: 5` | A job this service nacks without requeue reaches `video-validation.dlq` / `processing.dlq`; a job that kills the process is dead-lettered at the limit. An explicit requeue is **not** bounded by the broker — that is RM-20's job |
| V1 — the Catalog's database tests were skipped in CI | CI runs them against PostgreSQL and fails on any skip | The Catalog side of RM-18's deduplication is proved in CI |
