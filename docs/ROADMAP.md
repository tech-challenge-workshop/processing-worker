# Processing Worker roadmap

What has been delivered in this repository, slice by slice, and what is still open. The slices are cross-repository; the platform's [README](https://github.com/tech-challenge-workshop/fiap-x-platform) describes the whole system, and each slice's spec is under [`.specs/features/`](../.specs/features/).

## Delivered

Dates are merge dates on `main`.

| Slice | What it gave the Worker | Merged |
| --- | --- | --- |
| Foundation | Repository, NestJS app, a validation consumer, then RabbitMQ transport and a simulated processing consumer for a local Docker run | 2026-08-25 to 08-29, direct commits |
| Local-first stack | Local object storage and the concurrency envelope recorded in the boundary (AD-005, AD-006) | #1, 2026-09-19 |
| S1 · CI | `quality` job: lint, typecheck, unit and e2e tests, build | #2, 2026-09-20 |
| S2 · Lifecycle | Every processing outcome reported: started, completed, failed | #4, 2026-09-21 |
| S3 · Persistence | A test that guards the broker topology the Worker depends on | #5, 2026-09-21 |
| S4 · Real media | FFprobe validation, FFmpeg frames, stored ZIP under `zips/`, S3 adapter, per-queue prefetch, deterministic outcome ids, pause before requeue | #6, 2026-09-26 |
| Spec A · Messaging hardening | In-flight jobs left unacked once shutdown begins; the V19 follow-ups (MSG-12..15) | #7, 2026-09-26 |
| Spec F · Robustness | Shutdown hook pinned, CI broker-suite guard tested, only `MessageRejectedError` is permanent (ROB-06..09) | #8, 2026-09-27 |
| S7 · Email | Nothing here: the terminal event is the Catalog's, and the Worker stays free of email addresses (AD-015) | - |
| S8 · Observability | Correlation id carried onto every outcome, JSON logs with redaction, job metrics, real readiness (AD-016, AD-017) | #9, 2026-09-29 |
| S9a · Kubernetes | Multi-arch image published to GHCR on every merge to `main`; KEDA scales it in the kind cluster (AD-018) | #10, 2026-09-29 |

## Open items

From the verification record kept alongside the project ("Validar depois"). None blocks the delivered flow.

- **V58**: `{"pattern":"ProcessingQueued","data":null}` (and the validation equivalent) throws a `TypeError`, which is treated as transient and requeued forever. Also: no test proves the broker suite obeys its CI guard, and `test/s3-object-storage.e2e-spec.ts` keeps a guard of its own.
- **V59**: a storage key can leak through an S3 SDK error's `Key` and `Resource` properties when Nest logs the error whole; the redact paths do not cover them. Fix: redact those fields or wrap SDK errors, with an e2e against a stub S3.
- **V60**: nothing tests the production default of `LOG_DESTINATION`; every test overrides it. Error lines from the `RpcExceptionsHandler` also come out without `correlationId`.
- **V65**: flaky test: the S8 health e2e behind a TCP relay failed once (0 in the next 10 runs).
- **V66**: the consumers write no log line per handled message, so a correlation id cannot be followed through the Worker's logs. Fix: one `info` line per message (event, result, `processingRequestId`).
- **V68**: the arm64 image build runs under QEMU and can hang until the job's 30-minute timeout, so a `:main` image can silently fail to publish. Fix: build each platform on a native runner and merge the manifests.
- **V70**: `main.ts` never calls `app.enableShutdownHooks()` and the image runs `node` as PID 1, so `SIGTERM` skips the shutdown flag: a pod on scale-in keeps consuming until it is killed at 30 s. Jobs stay correct (unacked work is redelivered), but scale-in is slower.
- **V73**: `GET /` still answers `Hello World!`; comments still say "S4 replaces this" or "Until then"; the duplicate check is in memory per process, not shared between replicas.
