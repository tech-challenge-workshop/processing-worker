# Processing Worker service boundary

The Worker does the media work and reports what happened; it decides nothing about a request's lifecycle. This page is its contract with the rest of the system; the mechanics are in the [README](../README.md).

## Owns

- Validating the real uploaded file with FFprobe: size, readability, duration, container family, a video stream ([README, Validation](../README.md#validation-video-validation-queue)).
- Extracting one frame per second with FFmpeg and packing the frames into a ZIP.
- Reading sources from, and writing ZIPs to, private S3-compatible object storage under a deterministic key.
- Publishing one outcome event per job, with an event id derived from the consumed one.
- Its concurrency envelope: per-queue prefetch, `FFMPEG_THREADS` matched to the CPU limit, stateless replicas (AD-006).

## Does not own

- Request state, attempts or retries: `processing-catalog` decides; a new attempt is its call.
- Users, tokens, ownership checks and presigned URLs: `fiap-x-api`. The Worker serves no user traffic.
- Email: `notification-service`. The Worker never sees an email address (AD-015).
- Any database. The Worker has no tables.
- Queue declarations with arguments, dead-lettering and delivery limits: the platform's broker definitions and policy (AD-011, AD-012).
- The bucket, its credentials and its 7-day lifecycle rules: the platform's storage bootstrap.

## Interfaces

**Consumed** (JSON Nest envelopes, manual ack):

| Queue | Event | Fields it uses |
| --- | --- | --- |
| `video-validation` | `VideoValidationRequested` | `eventId`, `processingRequestId`, `sourceStorageKey`, `occurredAt` |
| `processing` | `ProcessingQueued` | the above plus `attemptId` |

**Published**, one queue per outcome: `VideoAccepted` (`video.accepted`), `VideoRejected` (`video.rejected`, `failureCode` `FORMATO_INVALIDO` or `DURACAO_EXCEDIDA`), `ProcessingStarted` (`processing.started`), `ProcessingCompleted` (`processing.completed`, `zipStorageKey`), `ProcessingFailed` (`processing.failed`, `PROCESSAMENTO_FALHOU`). Every outcome carries `eventId`, `processingRequestId`, `occurredAt`, `attemptId` on processing outcomes, and `correlationId` (AD-016). There is no version field: each service keeps its own DTOs of the same JSON (AD-003). Details: [README, Messaging](../README.md#messaging).

**Object storage** (S3 API, path-style): head and download `sourceStorageKey`; head and upload `zips/<processingRequestId>/<attemptId>/frames.zip`.

**HTTP**: `/health` (broker connected, `ffmpeg` and `ffprobe` present), `/health/live`, `/metrics`.

## Data

Nothing durable of its own. The ZIP is an object in the shared bucket, addressed by the key above and reported to the Catalog. Handled `eventId`s are remembered in memory, per process, as a shortcut only.

## Invariants

- A message is acked only after its outcome is published; nothing is acked before the effect.
- A redelivery produces the same event ids and addresses the same ZIP key, and an archive already stored is returned without running FFmpeg again, so the Catalog absorbs the repeat.
- The ZIP is uploaded last: a failure before it leaves no object behind.
- FFmpeg and FFprobe run as child processes with an argument vector, a timeout and a kill; their temp directory is always removed.
- Failure codes come from the closed vocabulary shared with the Catalog.

## Failure policy

- A file that fails validation: `VideoRejected`, acked. Any packaging error during processing (storage, FFmpeg, zero frames): `ProcessingFailed`, acked. No automatic business retry.
- A message missing its ids: `nack` without requeue, to `<queue>.dlq`. A body that is not JSON: dead-lettered by Nest before any handler.
- Anything transient during validation or a failed publish: requeued after `RABBITMQ_RETRY_BACKOFF_MS` (AD-012).
- Once shutdown has begun, a processing job publishes nothing and leaves its message unacked for redelivery. `SIGTERM` does not yet run that path (V70 in the [roadmap](ROADMAP.md#open-items)); unacked messages are still redelivered.

## Decisions that bind it

AD-001, AD-003, AD-005 (standard protocols only), AD-006 (concurrency model), AD-011 and AD-012 (broker-owned topology, classify then settle), AD-014 (any S3 server; RustFS locally), AD-015 (no PII here), AD-016, AD-017 (logs, redaction, metrics) and AD-018 (image on GHCR; KEDA scales it from 1 to 5 replicas on queue depth). The log is [`fiap-x-platform/.specs/STATE.md`](https://github.com/tech-challenge-workshop/fiap-x-platform/blob/main/.specs/STATE.md).
