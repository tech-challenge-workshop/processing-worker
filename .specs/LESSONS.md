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

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
