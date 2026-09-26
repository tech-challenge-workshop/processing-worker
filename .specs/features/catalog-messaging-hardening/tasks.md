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

- [ ] Swapping the two checks in the validator turns the first case red
- [ ] Quick gate passes

**Tests**: unit
**Gate**: quick

---

### T3: Closing mid-job never acks

**What**: An e2e test holds the packager on a promise, delivers one `ProcessingQueued`, closes the app, then releases the promise.

**Where**: `test/processing.e2e-spec.ts`
**Depends on**: None
**Reuses**: The processing e2e composition and its fake channel
**Requirement**: MSG-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] No `ack` is recorded, and no `ProcessingCompleted` or `ProcessingFailed` is published
- [ ] An `ack` added before the packager is awaited turns the test red
- [ ] If the composition cannot close mid-handler, report that before changing any behaviour (design.md)
- [ ] Full gate passes

**Tests**: e2e
**Gate**: full

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

- [ ] Both cases pass against a local broker loaded with the definitions
- [ ] `CI=true` without `RABBITMQ_TEST_URL` fails the suite
- [ ] Discrimination:
  - With `PREFETCH_PROCESSING=3`, the prefetch case goes red.
  - Treating `SyntaxError` as transient makes the DLQ case go red.
- [ ] The workflow parses. Its RabbitMQ service mounts the definitions from a checkout of `tech-challenge-workshop/fiap-x-platform`
- [ ] Build gate passes

**Tests**: integration
**Gate**: build

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
| T3 | 1 test | ✅ Granular |
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
| T3 | Consumer lifecycle (test) | e2e | e2e | ✅ OK |
| T4 | Broker behaviour + CI | integration | integration | ✅ OK |
