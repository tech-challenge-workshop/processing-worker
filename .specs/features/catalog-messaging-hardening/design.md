# Catalog Messaging Hardening Design — worker

**Spec**: `.specs/features/catalog-messaging-hardening/spec.md`
**Status**: Draft

---

## Architecture Overview

This is test work, with no behaviour change. Three items live in the existing suites; the fourth adds one broker-backed e2e suite and a RabbitMQ service in CI.

---

## Code Reuse Analysis

| Component | Location | How to Use |
| --- | --- | --- |
| Save/clear/restore of environment variables | `test/composition.e2e-spec.ts:40-47` | Applied to `test/health.e2e-spec.ts` (MSG-12) |
| `FfprobeVideoValidator` spec | `src/validation/ffprobe-video-validator.spec.ts` | Two precedence cases with a fake probe (MSG-13) |
| `ProcessingConsumer` + an injectable `FramePackager` | `src/processing/processing.consumer.ts` | Held packager promise; the app is closed mid-job (MSG-14) |
| `consumerOptions`, prefetch defaults | `src/messaging/consumer-options.ts` | The broker suite starts the Worker with `PREFETCH_PROCESSING=1` (MSG-15) |
| The platform's broker definitions | `fiap-x-platform/rabbitmq/definitions.json` | CI loads them into the RabbitMQ service, so queues, DLQs and the `dead-letter` policy match the stack (AD-011, AD-012) |

---

## Components

### `test/health.e2e-spec.ts` (MSG-12)

- **Change**: in `beforeAll`, save and delete every `STORAGE_*` and `AWS_*` variable the storage module reads; in `afterAll`, restore them.
- **Proof**: a test sets `STORAGE_ENDPOINT=http://127.0.0.1:9` before the save and expects the same results.

### Validator precedence (MSG-13)

- **Change**: two unit cases, with an overlong `mkv` probe and a short `mkv` probe.
- **Spec note**: the RM-07 precedence is also recorded as a sentence in `real-media-processing/spec.md` (traceability note only).

### Shutdown mid-job (MSG-14)

- **Test**: e2e with the in-memory broker adapter the processing e2e already uses.
  1. The packager returns a promise held by the test.
  2. Deliver one `ProcessingQueued`, then call `app.close()`, then release the promise.
  3. Assert `ack` was never called and no terminal event was published.
- **Fallback**: if the current composition cannot close mid-handler without the handler finishing, the implementer reports it before changing any behaviour.

### `test/broker.e2e-spec.ts` (new, MSG-15)

- **Gate**: `RABBITMQ_TEST_URL` is required. When `CI` is set and the variable is missing, the suite fails; locally it skips.
- **Prefetch**:
  1. Start the Worker app with `PREFETCH_PROCESSING=1` and a held packager.
  2. Publish three `ProcessingQueued` messages.
  3. Wait until one is in flight, then `checkQueue('processing')`: `messageCount` must be 2.
- **Non-JSON**:
  1. Publish a raw `not json` body to `video-validation`.
  2. Within a few seconds, `checkQueue('video-validation.dlq').messageCount` grows by 1, and the body is received from the DLQ.
- **Cleanup**: purge the queues the suite used before and after.
- **CI**: in the e2e job, add a `rabbitmq:4-management` service that mounts `fiap-x-platform/rabbitmq/definitions.json` from a checkout of the public platform repository, as the Catalog's CI does with `01-schemas.sql`. Set `RABBITMQ_TEST_URL`.
- **Local**: the stack does not publish 5672 to the host, so run a dedicated broker loaded with the same definitions: `docker run -d -p 55672:5672 -v ../fiap-x-platform/rabbitmq:/etc/rabbitmq/conf.d… rabbitmq:4-management`, mirroring the stack's `rabbitmq` service. Then set `RABBITMQ_TEST_URL=amqp://guest:guest@localhost:55672`.

---

## Risks & Concerns

| Concern | Location | Impact | Mitigation |
| --- | --- | --- | --- |
| The CI broker must match the stack's definitions | CI | A queue declared with other arguments gives `PRECONDITION_FAILED` | Load the same `definitions.json`; the Worker declares no arguments (AD-011) |
| Timing of "one in flight" | Broker suite | A flaky read | Poll `checkQueue` until `messageCount` is 2, with a deadline, rather than sleeping |
| A dedicated local broker must match the stack | Broker suite | Drift from the stack's queues | It mounts the platform's own `definitions.json` and `rabbitmq.conf`; purge before and after |

---

## Tech Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where the broker checks live | The Worker's own e2e | Spec A touches no platform code; same pattern as the API's RustFS suite |
