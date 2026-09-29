# Observability — Processing Worker Specification

Part of S8 (observability and autoscale), split across 5 sibling specs (`fiap-x-api` OBS-01..15, `processing-catalog` OBS-16..30, `processing-worker` OBS-31..45, `notification-service` OBS-46..60, `fiap-x-platform` OBS-61..75). This repo's job: propagate the `correlationId` through validation and processing (republishing it on every outcome event), emit the processing/validation metrics that prove RF-1 on the dashboard, and split health into readiness/liveness.

## Problem Statement

The Worker is where RF-1 either happens or doesn't, yet today there is no metric for validation outcomes, processing duration, or in-flight jobs, and no correlation id linking a consumed job to the outcome events it publishes. Its health endpoint already separates readiness from a `/live` liveness probe, but readiness does not flow into any scrape, and the shutdown-aware consumer path has no observable signal. The `foudation.md` names processing duration/failure rate and queue depth as part of the minimum metric set.

## Goals

- [ ] Every consumed job's `correlationId` flows into the Worker's logs and is republished on every outcome event (`VideoAccepted`/`VideoRejected`/`ProcessingStarted`/`ProcessingCompleted`/`ProcessingFailed`).
- [ ] `GET /metrics` exposes `fiapx_validation_total`, `fiapx_processing_total`, `fiapx_processing_duration_seconds`, and in-flight job gauges per queue.
- [ ] Readiness (`/health`) reports not-ready when RabbitMQ is unreachable while liveness (`/health/live`) stays 200, and both are scrape-friendly.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Changing the concurrency model (prefetch, `ffmpeg -threads`) | Locked by AD-006/S4; S8 only observes it |
| FFmpeg internal metrics | Process-level signals out of scope; job duration covers the operator need |
| RabbitMQ queue-depth metrics | Broker plugin, wired in `fiap-x-platform` |
| KEDA / horizontal autoscale | S9a; compose-level replicas are the platform spec's OBS-64 |
| Unifying exchange naming (`fiapx.events` vs `fiapx-events`) or any queue topology change | Topology is frozen by specs A–F; changing it is a contract migration outside S8 scope |
| Publisher confirms rework | The Worker keeps its current emit-based publisher; S8 does not change delivery semantics |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| correlationId transport | Read from the consumed message into the log context; republish the same id on every outcome event; generate one when absent or invalid | Keeps the chain unbroken end-to-end; matches the API/Catalog contract decision | n (user skipped; default chosen — review at confirm) |
| Outcome events carry `correlationId` | Added to the Worker DTOs for all five outcome events, mirroring the Catalog's event contract | Contract decision shared across repos |
| Duration metric | `fiapx_processing_duration_seconds` histogram covers the processing queue only (the queue that proves RF-1); validation duration observed via logs, not a histogram | Keeps the dashboard focused; validation is cheap per AD-006 |
| Metric labels | Bounded only (`queue`, `outcome`, `failure_code`); no request ids, storage keys, or paths as labels | Cardinality; storage keys are internal detail (S6 rule) |
| Logs | `nestjs-pino` JSON with the job's `correlationId`; temp workspace paths and storage keys are not logged at info level (debug at most) | Storage keys never leak (S6); temp paths are noise |
| Health semantics | `/health` keeps its existing dependency checks (rabbitmq, ffmpeg, storage adapter) responding 503 when any is down; `/health/live` stays 200 | Existing behavior already matches the seed criterion; S8 standardizes the path and wires it to the scrape |
| Health/metrics endpoints | Unauthenticated; not access-logged | Scraping convention; noise |

**Open questions:** none — all resolved or logged above.

---

## User Stories

### P1: correlationId through validation and processing ⭐ MVP

**User Story**: As an operator, I want each job's correlation id in every Worker log line and republished on every outcome event so that a job consumed from the queue traces to its published result without a break.

**Why P1**: The Worker is the middle of the chain; losing the id here severs the trace exactly where RF-1's evidence lives.

**Acceptance Criteria**:

1. WHEN a consumer receives a message THEN the Worker SHALL set the log correlation context from the message's `correlationId` before handling and SHALL clear it when the handler settles. <!-- event-driven -->
2. WHEN the validation consumer publishes `VideoAccepted` or `VideoRejected` THEN the event SHALL carry the same `correlationId` as the consumed message. <!-- event-driven -->
3. WHEN the processing consumer publishes `ProcessingStarted`, `ProcessingCompleted`, or `ProcessingFailed` THEN the event SHALL carry the same `correlationId` as the consumed message. <!-- event-driven -->
4. IF the consumed message lacks a `correlationId` or carries an invalid one THEN the consumer SHALL generate a fresh id for its log context, SHALL still publish outcomes, and SHALL NOT fail the message. <!-- unwanted-behavior -->
5. WHEN the Worker emits any log line THEN it SHALL be JSON carrying `timestamp`, `level`, `msg`, `service`, and the current `correlationId`. <!-- event-driven -->
6. WHEN the Worker logs about a job THEN the line SHALL NOT contain the source storage key, the ZIP storage key, or a presigned URL. <!-- event-driven -->

**Independent Test**: Broker e2e: publish a `VideoValidationRequested` with `correlationId: w-7`, assert the published `VideoAccepted` carries `w-7` and every Worker log line between consume and publish carries the same id; republish without the field and assert a generated id flows instead.

---

### P2: Processing metrics and scrape-friendly health

**User Story**: As an operator, I want Prometheus counters/histograms for validation and processing outcomes, duration, and in-flight jobs, plus scrape-friendly readiness/liveness, so that the dashboard shows throughput following queue depth during the load test.

**Why P1**: This is the RF-1 evidence and half of the S8 "pronto quando".

**Acceptance Criteria**:

1. WHEN Prometheus scrapes `GET /metrics` THEN the response SHALL include `fiapx_validation_total{outcome="accepted|rejected"}`, `fiapx_processing_total{outcome="completed|failed"}`, `fiapx_processing_duration_seconds`, and `fiapx_jobs_inflight{queue="validation|processing"}`. <!-- event-driven -->
2. WHEN validation rejects a file THEN the Worker SHALL increment `fiapx_validation_total` with `outcome="rejected"` and SHALL NOT increment `"accepted"`. <!-- event-driven -->
3. WHEN processing finishes, successfully or not, THEN the Worker SHALL increment `fiapx_processing_total` with the matching `outcome` and SHALL observe into `fiapx_processing_duration_seconds` the elapsed seconds measured from handler start until the handler settles. <!-- event-driven -->
4. WHILE a job is being handled THEN the matching `fiapx_jobs_inflight` gauge SHALL be incremented before handling starts and decremented when the handler settles, including on failure. <!-- state-driven -->
5. WHILE RabbitMQ is unreachable THEN `GET /health` SHALL respond 503 and `GET /health/live` SHALL respond 200. <!-- state-driven -->
6. The metric exposition and health endpoints SHALL NOT require authentication and SHALL NOT produce access-log lines. <!-- ubiquitous -->

**Independent Test**: Run the broker e2e with one accepted and one rejected validation plus one completed and one failed processing: `/metrics` shows exactly those four increments, one duration observation, and an inflight gauge that returns to zero after settle; stop the broker and `/health` flips 503 while `/health/live` stays 200.

---

## Edge Cases

- IF a handler throws before publishing THEN the inflight gauge SHALL still be decremented (defer/finally) and the consumed counter SHALL reflect the settlement the existing retry logic chooses.
- IF the message `correlationId` is numeric or an object THEN it is treated as invalid and replaced (never stringified into `"null"` — the L-010 lesson: a newly meaningful field gets parsed strictly, not presence-checked).
- WHEN the shutdown flag is set mid-job THEN the existing "left for redelivery" behavior is unchanged; the inflight gauge is decremented as the handler settles.
- IF `/metrics` is scraped during a job THEN the registry snapshot is consistent (gauges/counters read atomically from the registry).

---

## Implicit-Requirement Dimensions Sweep

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | OBS-34: strict parsing of the new `correlationId` field (no `String()` coercion) |
| Failure / partial-failure | OBS-40: inflight gauge released on failure; settlement counters reflect the retry decision |
| Idempotency / retry / duplicate | Unchanged — existing redelivery/shutdown semantics observed, not modified |
| Auth boundaries | `/health`, `/health/live`, `/metrics` public by design |
| Concurrency / ordering | Per-message ALS context under concurrent handlers; gauges use the shared registry |
| Data lifecycle / expiry | N/A — no persistence in this service |
| Observability | this feature |
| External-dependency failure | Seed criterion 3 codified as OBS-41 |
| State-transition integrity | N/A — the Worker publishes facts; it owns no state machine |

---

## Requirement Traceability

| Requirement ID | Story | Tasks | Phase | Status |
| --- | --- | --- | --- | --- |
| OBS-31 | P1: correlationId (consume context) | T1, T6, T8, T9, T10, T15 | Execute | In progress (T1, T6, T8, T9 done) |
| OBS-32 | P1: correlationId (validation outcomes) | T5, T7, T9, T15 | Execute | Implemented (T5, T7, T9); e2e proof in T15 |
| OBS-33 | P1: correlationId (processing outcomes) | T5, T7, T10, T15 | Execute | In progress (T5, T7 done) |
| OBS-34 | P1: correlationId (fallback) | T1, T8, T15 | Execute | Implemented (T1, T8); e2e proof in T15 |
| OBS-35 | P1: structured logs (JSON shape) | T2, T3, T4, T15 | Execute | Implemented (T2-T4); e2e proof in T15 |
| OBS-36 | P1: structured logs (no storage keys) | T2, T15 | Execute | Implemented (T2); e2e proof in T15 |
| OBS-37 | P2: Metrics (exposition set) | T11, T12, T14, T15 | Tasks | Pending |
| OBS-38 | P2: Metrics (validation outcome) | T11, T12, T15 | Tasks | Pending |
| OBS-39 | P2: Metrics (processing outcome + duration) | T11, T13, T15 | Tasks | Pending |
| OBS-40 | P2: Metrics (inflight gauge) | T11, T12, T13, T15 | Tasks | Pending |
| OBS-41 | P2: Health (not-ready on broker loss) | T14, T15 | Tasks | Pending |
| OBS-42 | P2: Health/Metrics (no auth, no noise) | T2, T14, T15 | Tasks | Pending |

**ID format:** `OBS-[NUMBER]` — `fiap-x-api` owns OBS-01..15; `processing-catalog` OBS-16..30; this repo owns OBS-31..45; `notification-service` OBS-46..60; `fiap-x-platform` OBS-61..75.

**Coverage:** 12 total, 12 mapped to tasks, 0 unmapped.

---

## Success Criteria

- [ ] A job consumed with `correlationId: w-7` republishes that id on its outcome event, with matching log lines in between, provable on a real broker.
- [ ] After the four-outcome broker test, `/metrics` shows exactly 4 outcome increments, ≥1 duration observation, and zero inflight.
- [ ] With the broker stopped: `/health` 503, `/health/live` 200, `/metrics` 200.
