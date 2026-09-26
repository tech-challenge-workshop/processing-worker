# Catalog Messaging Hardening Tasks — worker

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.** (In this project's sessions the skill is not registered by name; the user has authorized reading it from `.agents/skills/tlc-spec-driven/` by path.)

---

**Design**: `.specs/features/catalog-messaging-hardening/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec — confirm before Execute. Guidelines found: none, so strong defaults apply. Same commands as `real-media-processing/tasks.md` (S4).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Test harness (health isolation) | e2e | Same results with the storage variables set to junk values; the variables are restored afterwards | `test/health.e2e-spec.ts` | `npm run test:e2e` |
| Validator | unit | Both precedence cases | `src/validation/*.spec.ts` | `npm test` |
| Consumer lifecycle | e2e | Close the app mid-job: no ack, and no terminal event | `test/processing.e2e-spec.ts` or a new suite | `npm run test:e2e` |
| Broker behaviour | integration | Prefetch excess stays `ready`; non-JSON goes to the DLQ on first delivery; the suite fails in CI without a broker | `test/broker.e2e-spec.ts` | `RABBITMQ_TEST_URL=… npm run test:e2e` |
| CI workflow | none | The workflow parses, and the RabbitMQ service loads the platform's definitions | `.github/workflows/ci.yml` | build gate |

## Gate Check Commands

> Generated from codebase — confirm before Execute. For T4, run a dedicated broker with the platform's definitions on host port 55672 (see design.md) and set `RABBITMQ_TEST_URL=amqp://guest:guest@localhost:55672`. With that set, nothing may skip.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | Unit-only tasks | `npm test` |
| Full | e2e tasks | `npm test && npm run test:e2e` |
| Build | Last task | `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` |

---

## Execution Plan

### Phase 1: The four follow-ups

```
T1
T2
T3
T4
```

---

## Task Breakdown

### T1: The health suite ignores the shell

**What**: `test/health.e2e-spec.ts` saves, clears and restores every storage variable the storage module reads.
**Where**: `test/health.e2e-spec.ts`
**Depends on**: None
**Reuses**: `test/composition.e2e-spec.ts:40-47`
**Requirement**: MSG-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Running the suite with `STORAGE_ENDPOINT=http://127.0.0.1:9` exported gives the same results as without it, and so does running it with junk credentials. Show both runs
- [x] The variables hold their prior values after the suite
- [x] Full gate passes

**Tests**: e2e
**Gate**: full

**Status**: ✅ Done. The readiness suite saves, clears and restores the four `STORAGE_*` variables `createObjectStorage` reads; no `AWS_*` variable is read by the storage module, so none is touched (design.md named them). A file-level hook exports an unreachable endpoint and junk credentials around the suite in every run, and a last test checks those values are back afterwards. Health suite 6/6 in a clean shell, with `STORAGE_ENDPOINT=http://127.0.0.1:9`, and with junk credentials; before the change the junk-credential run failed 3 of 5. Negatives: dropping the clear turns the 3 readiness-body tests red; dropping the restore turns the restore test red. Full gate: unit 163/163, e2e 52/52 (was 51), none skipped.

---

### T2: Pin the duration-over-format precedence

**What**: Add two validator unit cases:

- an over-limit `mkv` probe → `DURACAO_EXCEDIDA`;
- a short `mkv` probe → `FORMATO_INVALIDO`.

Also add a traceability note on RM-07 in `real-media-processing/spec.md`.

**Where**: `src/validation/ffprobe-video-validator.spec.ts`
**Depends on**: None
**Reuses**: The existing fake probe
**Requirement**: MSG-13

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Swapping the two checks in the validator turns the first case red
- [x] Quick gate passes

**Tests**: unit
**Gate**: quick

**Status**: ✅ Done. Two cases in `src/validation/ffprobe-video-validator.spec.ts` with the stub probe: `matroska,webm` at 601 s gives `DURACAO_EXCEDIDA`, at 8 s `FORMATO_INVALIDO`. Both pin today's behaviour, so they were green on first run; the red is the negative: moving the container check above the duration check fails the first case only (1 failed, 18 passed). RM-07 in `real-media-processing/spec.md` carries a precedence note. Quick gate: unit 165/165 (was 163).

---

### T3: Closing mid-job never acks

**What**: An e2e test holds the packager on a promise, delivers one `ProcessingQueued`, closes the app, then releases the promise. Includes the behaviour change decided 2026-09-26: a `ShutdownSignal` flag set on app close, checked by the consumer after the packager settles, so an in-flight job publishes no terminal event and does not ack once shutdown has begun.

**Where**: `test/processing.e2e-spec.ts`, `src/processing/shutdown-signal.ts` (new), `src/processing/processing.consumer.ts`, `src/processing/processing.module.ts`
**Depends on**: None
**Reuses**: The processing e2e composition and its fake channel
**Requirement**: MSG-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] No `ack` is recorded, and no `ProcessingCompleted` or `ProcessingFailed` is published (packager released and packager rejected after close)
- [x] An `ack` added before the packager is awaited turns the test red
- [x] Removing the flag check turns the test red
- [x] The composition could not close mid-handler without the handler finishing: reported, and the user chose the behaviour change (2026-09-26)
- [x] Full gate passes

**Tests**: e2e
**Gate**: full

**Status**: ✅ Done, with the behaviour change the user chose on 2026-09-26. The first run showed `app.close()` neither waits for nor cancels an in-flight handler: released after close, the job published `ProcessingCompleted` and acked. `ShutdownSignal` (`src/processing/shutdown-signal.ts`, provided by `ProcessingModule`) sets `isClosing` in `onModuleDestroy`, the first hook `close()` runs, before `dispose` closes the consumer servers and before `onApplicationShutdown` closes the publisher clients. After the packager settles, success or failure, `ProcessingConsumer` checks it; if set, it logs one warning and returns without publishing, acking or nacking. Two e2e cases in `test/processing.e2e-spec.ts` build the app, deliver one `ProcessingQueued` with a recording channel, close the app while the packager is held, then resolve or reject it: the channel records nothing and only `ProcessingStarted` is published. Both were red before the change (ack plus the terminal event). Negatives: dropping the flag check turns both red; an ack issued before the packager is awaited turns both red. The consumer unit spec registers `ShutdownSignal` in its four testing modules (wiring only; no assertion changed). Build gate with `CI=true`, `STORAGE_ENDPOINT` and `RABBITMQ_TEST_URL` in `node:22-alpine` with ffmpeg: lint 0, typecheck 0, unit 165/165, e2e 56/56 (was 54), none skipped, build 0.

---

### T4: Prove the broker behaviours against RabbitMQ

**What**: Add a new `test/broker.e2e-spec.ts` that runs against `RABBITMQ_TEST_URL`. When `CI` is set and the variable is missing, the suite fails instead of skipping. It covers two behaviours:

- prefetch 1 with 3 messages queued → `messageCount` 2;
- a non-JSON body → exactly one message in `video-validation.dlq`.

In CI, the e2e job gains a `rabbitmq:4-management` service that loads the platform's `definitions.json` and `rabbitmq.conf`, and sets `RABBITMQ_TEST_URL`.

**Where**: `test/broker.e2e-spec.ts` (+ `.github/workflows/ci.yml`)
**Depends on**: None
**Reuses**: The platform's `rabbitmq/` definitions; the API's `STORAGE_TEST_ENDPOINT` pattern (S6)
**Requirement**: MSG-15

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Both cases pass against a local broker loaded with the definitions
- [x] `CI=true` without `RABBITMQ_TEST_URL` fails the suite
- [ ] Discrimination:
  - [x] With `PREFETCH_PROCESSING=3`, the prefetch case goes red.
  - [ ] Treating `SyntaxError` as transient makes the DLQ case go red. **Not met as written** - see Status.
- [x] The workflow parses. Its RabbitMQ service mounts the definitions from a checkout of `tech-challenge-workshop/fiap-x-platform`
- [x] Build gate passes

**Tests**: integration
**Gate**: build

**Status**: ⚠️ Done, with one discrimination criterion unmet as written. `test/broker.e2e-spec.ts` starts the Worker as `main.ts` composes it (both consumers from `consumerOptions`, a packager that never resolves) against `RABBITMQ_TEST_URL`; it fails in CI when the URL is unset (1 failed, 2 skipped) and skips locally (2 skipped). Prefetch: 3 `ProcessingQueued` published, `checkQueue('processing').messageCount` polled to 2 within 10 s, still 2 a second later, and the packager reached once. Non-JSON: `video-validation.dlq` reaches exactly 1 within 10 s, the source queue is empty, and the dead-lettered message carries body `not json` and `x-death` `{ queue: 'video-validation', reason: 'rejected', count: 1 }`, so it was rejected on its first delivery, not dropped by the delivery limit. Both queues used, plus the DLQ, are purged before and after each case.

Negatives: `PREFETCH_PROCESSING=3` fails the prefetch case (expected 2, received 0). Removing `SyntaxError` from `isPermanentFailure` leaves the DLQ case **green**: Nest's `ServerRMQ.parseMessageContent` swallows the parse error and passes the raw string on, the packet has no pattern, and `handleEvent` nacks it without requeue before any Worker code runs, so the Worker's `SyntaxError` branch is never reached by a non-JSON body. The test does discriminate the mechanism that actually dead-letters: changing that Nest nack to requeue fails it (expected 1, received 0). Whether the `SyntaxError` branch is dead code for this input is left for the Verifier.

CI: the RabbitMQ is a `docker run` step, not a job `services:` entry, because a service starts before any checkout exists to mount. It runs `rabbitmq:4-management` with the platform's `rabbitmq.conf` and `definitions.json` from a sparse checkout of `tech-challenge-workshop/fiap-x-platform` (identical to the local copies), mounted where the platform compose mounts them, waits for the port and for `video-validation.dlq` to exist, and `RABBITMQ_TEST_URL` is set on the e2e step. The workflow parses (PyYAML). Build gate with `CI=true`, `STORAGE_ENDPOINT` and `RABBITMQ_TEST_URL`: lint 0, typecheck 0, unit 165/165, e2e 54/54 (was 52), none skipped, build 0.

---

## Phase Execution Map

```
Phase 1 (T1 T2 T3 T4)
```

4 tasks. This repository comes last in the cross-repository order.

---

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 | 1 suite | ✅ Granular |
| T2 | 2 test cases (+ spec note) | ✅ Granular |
| T3 | 2 test cases + 1 flag provider and its check | ✅ Granular |
| T4 | 1 suite + its CI service | ⚠️ OK - cohesive; the suite cannot run in CI without the service |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows (within phase) | Status |
| --- | --- | --- | --- |
| T1 | None | — | ✅ Match |
| T2 | None | — | ✅ Match |
| T3 | None | — | ✅ Match |
| T4 | None | — | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Test harness | e2e | e2e | ✅ OK |
| T2 | Validator (tests) | unit | unit | ✅ OK |
| T3 | Consumer lifecycle (flag + test) | e2e | e2e | ✅ OK |
| T4 | Broker behaviour + CI | integration | integration | ✅ OK |
