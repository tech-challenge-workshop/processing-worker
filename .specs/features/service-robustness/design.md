# Service Robustness Design — worker

**Spec**: `.specs/features/service-robustness/spec.md`
**Status**: Draft

---

## Architecture Overview

Three changes. No new runtime component.

| Change | File | What |
| --- | --- | --- |
| Hook-order test (ROB-06) | `test/processing.e2e-spec.ts` | A test-only provider's `beforeApplicationShutdown` resolves the held packager. In Nest this hook runs after `onModuleDestroy`, where the flag is set, and before `dispose` and `onApplicationShutdown`. The test asserts no `ack` and no terminal event. If the flag moves to `onApplicationShutdown`, the job settles while the flag is still false, so it acks and the test fails |
| Window note (ROB-07) | `src/processing/shutdown-signal.ts` | A doc comment explains the window. A job that passed the flag check just before shutdown may still publish `ProcessingCompleted`, and a redelivery may publish it again. The Catalog drops the repeat by `eventId` (AD-010). This is accepted, as decided on 2026-09-26 |
| CI guard (ROB-08) | new `brokerSuiteMode(env): 'run' \| 'skip' \| 'fail'` | `test/broker.e2e-spec.ts` uses it. Unit tests cover four cases: `{CI:'true'}` → fail, `{}` → skip, `{RABBITMQ_TEST_URL:'amqp://x'}` → run, `{CI:'false'}` → skip. Put it where the unit Jest config reaches (`src/`, since the unit config only looks there) |
| Dead branch (ROB-09) | `src/messaging/settle-failed-message.ts` | `isPermanentFailure` returns true only for `MessageRejectedError`. The comment says Nest nacks non-JSON before this code runs, and that the broker suite proves the DLQ |

---

## Risks & Concerns

| Concern | Impact | Mitigation |
| --- | --- | --- |
| This Nest version's hook order may differ from the spec A T3 finding | The test would not exercise the intended window | The implementer logs the hook order once in the test composition and records it |
| A test helper living in `src/` | A test-only module ships in the build | Name it clearly (`src/testing/broker-guard.ts`); it is pure and dependency-free |
