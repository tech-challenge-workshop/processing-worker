# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

_none_

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - When a spec requires a 'new' generated identifier (e.g. UUID), assert it is a well-formed fresh value (regex/format), not merely unequal to the input.
- signal: `spec_precision_gap` · recurrence: 1 feature(s) · scope: `src/validation` · harmful: 0
- features: initial-vertical-slice
- evidence: validation.consumer.spec.ts:49 (AC1) (src/validation)
- last seen: 2026-08-27T23:34:08Z

### L-002 - State the precedence between rejection rules that can both apply to one input, and pin it with a test
- signal: `spec_precision_gap` · recurrence: 1 feature(s) · harmful: 0
- features: real-media-processing
- evidence: src/validation/ffprobe-video-validator.ts:95
- last seen: 2026-09-25T22:15:54Z

### L-003 - An e2e test that asserts which adapter the root selects must clear every environment variable the selection reads, or it passes only in a clean shell
- signal: `ac_gap` · recurrence: 1 feature(s) · harmful: 0
- features: real-media-processing
- evidence: test/health.e2e-spec.ts:86
- last seen: 2026-09-25T22:15:54Z

### L-004 - When behaviour depends on which lifecycle hook sets a flag, test the event arriving between hooks, not only after the whole close.
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `lifecycle` · harmful: 0
- features: catalog-messaging-hardening
- evidence: src/processing/shutdown-signal.ts:15 (lifecycle)
- last seen: 2026-09-26T19:26:52Z

### L-005 - Probe what the framework does before your handler runs; a classification branch the framework pre-empts is dead code that only unit tests keep alive.
- signal: `spec_deviation` · recurrence: 1 feature(s) · scope: `messaging` · harmful: 0
- features: catalog-messaging-hardening
- evidence: src/messaging/settle-failed-message.ts:30 (messaging)
- last seen: 2026-09-26T19:26:52Z

### L-006 - Testing a guard function is not enough: also test that the caller obeys its verdict, or the call site can drop it with every test green.
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `testing` · harmful: 0
- features: service-robustness
- evidence: test/broker.e2e-spec.ts:24 (testing)
- last seen: 2026-09-27T01:18:11Z

### L-007 - Prove log-line content through the app's real logger wiring (shared context store and bootstrap logger), not only on a logger the test builds itself
- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `logging` · harmful: 0
- features: observability
- evidence: OBS-35; src/observability/observability.module.ts:14 (M14); src/main.ts:14 (M15) (logging)
- last seen: 2026-09-29T02:11:06Z

### L-008 - Prove log-line content through the app's real logger wiring (shared context store and bootstrap logger), not only on a logger the test builds itself
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `logging` · harmful: 0
- features: observability
- evidence: M14 observability.module.ts:14; M15 main.ts:14 (logging)
- last seen: 2026-09-29T02:11:06Z

### L-009 - Key-path log redaction does not cover values interpolated into message strings; keep secrets out of error messages and assert on a real log call site
- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `logging` · harmful: 0
- features: observability
- evidence: OBS-36; src/storage/s3-object-storage.ts:80; M16 processing.consumer.ts:144 (logging)
- last seen: 2026-09-29T02:11:06Z

### L-010 - Spec edge cases must name only metrics the design actually emits; reconcile the wording when the design drops a metric
- signal: `spec_precision_gap` · recurrence: 1 feature(s) · scope: `metrics` · harmful: 0
- features: observability
- evidence: OBS-39 + Edge case 1 (consumed counter not in design) (metrics)
- last seen: 2026-09-29T02:11:06Z

### L-011 - When a spec exempts endpoints from access logging, state how paths are matched (exact, prefix, query string)
- signal: `spec_precision_gap` · recurrence: 1 feature(s) · scope: `logging` · harmful: 0
- features: observability
- evidence: OBS-42; src/observability/logger.config.ts:53-56 (logging)
- last seen: 2026-09-29T02:11:06Z

### L-012 - Redact or strip identifiers that library errors carry as properties (e.g. S3 SDK Key/Resource), since logging an error object serializes every enumerable field
- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `logging` · harmful: 0
- features: observability
- evidence: OBS-36; probe P1: RpcExceptionsHandler err.Key/err.Resource from S3 SDK error; src/observability/logger.config.ts:24-36 (logging)
- last seen: 2026-09-29T02:34:02Z

### L-013 - When tests override a production default through an injection seam, add one check that the default still reaches its real target
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `testing` · harmful: 0
- features: observability
- evidence: M17 src/observability/observability.module.ts:18 (default LOG_DESTINATION) (testing)
- last seen: 2026-09-29T02:34:02Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
