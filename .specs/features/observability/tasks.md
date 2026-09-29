# Observability Tasks — Processing Worker

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/observability/design.md`
**Status**: Draft

> **Merge order**: order-free relative to the other service repos; merges before the `fiap-x-platform` S8 PR (which only wires scraping, no contract dependency on this repo's code).

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: CI workflow (`.github/workflows/ci.yml`: unit with coverage, e2e including a real broker suite, fail-on-skipped, lint `--max-warnings 0`, typecheck, build); `package.json` scripts; existing specs colocated `src/**/*.spec.ts` + `test/*.e2e-spec.ts`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Observability infra (context, logger, metrics) | unit | All branches; L-010 strict parse; inflight release on throw (L-009) | `src/observability/*.spec.ts` | `npm test` |
| Consumers / publisher touched | unit | 1:1 to touched ACs; happy + edge + error | colocated `*.spec.ts` | `npm test` |
| Broker-level behavior (correlation chain, metric increments) | e2e | Real broker: consumed message id republished on outcomes; four-outcome metric test; inflight returns to 0 | `test/*.e2e-spec.ts` | `npm run test:e2e` |
| Config / module wiring / main.ts | none | - (build gate only) | - | build gate only |

## Gate Check Commands

> Generated from `package.json` - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npm test` |
| Full | After tasks touching broker e2e | `npm test && npm run test:e2e` |
| Build | After phase completion or config-only tasks | `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build` |

---

## Execution Plan

Pure dependency chains: each task depends only on the previous one.

### Phase 1: Observability foundation

```
T1 -> T2 -> T3 -> T4 -> T5
```

### Phase 2: Correlation propagation

```
T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11
```

### Phase 3: Metrics and health

```
T11 -> T12 -> T13 -> T14 -> T15
```

### Phase 4: End-to-end verification

```
T15
```

---

## Task Breakdown

### T1: CorrelationContext (ALS + strict parser)

**What**: `runWithCorrelation`, `getCorrelationId`, `getOrGenerateCorrelationId`, `parseCorrelationId` (trim + `/^[\x20-\x7E]{1,128}$/`; non-strings → null — L-010).
**Where**: `src/observability/correlation-context.ts`
**Depends on**: None
**Reuses**: `node:async_hooks`, `node:crypto`
**Requirement**: foundation for OBS-31..34

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] Concurrent runs isolated; bounds and non-string rejections verified
- [x] Gate check passes: `npm test`
- [x] Test count: 10 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the correlation context for observability`

---

### T2: Pino root logger config

**What**: ALS `mixin`; redact paths (`req.headers.authorization`, `*.sourceStorageKey`, `*.zipStorageKey`, `*.url` defensive, `*.ownerEmail`, `*.email`); `autoLogging.ignore` for `/health`, `/health/live`, `/metrics`; `LOG_LEVEL` default `info`.
**Where**: `src/observability/logger.config.ts`
**Depends on**: T1
**Reuses**: T1
**Requirement**: OBS-35, OBS-36

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] Log lines single JSON with `service: 'processing-worker'` and the ALS correlation id
- [x] Redaction covers storage keys in nested objects (the S6 no-key rule now structural)
- [x] Gate check passes: `npm test`
- [x] Test count: 7 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the structured logger config with redaction`

---

### T3: ObservabilityModule

**What**: `LoggerModule.forRoot(rootConfig)` + CorrelationContext singleton.
**Where**: `src/observability/observability.module.ts`
**Depends on**: T2
**Reuses**: nestjs-pino
**Requirement**: OBS-35

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] Gate check passes: `npm run lint && npm run typecheck && npm run build`
- [x] Test count: no new tests (config layer - matrix)

**Tests**: none
**Gate**: build

**Commit**: `feat(worker): add the observability module`

---

### T4: Wire module into the app + pino bootstrap

**What**: Import ObservabilityModule (AppModule), `main.ts` buffers logs + `useLogger(Logger)` + `flushLogs` for both the HTTP app and the two RMQ microservice contexts.
**Where**: `src/app.module.ts`
**Depends on**: T3
**Reuses**: T3
**Requirement**: OBS-35

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] Boot emits JSON logs across HTTP and microservice paths
- [x] Gate check passes: `npm run lint && npm run typecheck && npm run build`
- [x] Test count: no new tests (wiring layer - matrix; e2e in T15)

**Tests**: none
**Gate**: build

**Commit**: `feat(worker): wire the observability module into the app`

---

### T5: Outcome DTO family gains the field

**What**: The five outcome DTOs (`video-accepted`, `video-rejected`, `processing-started`, `processing-completed`, `processing-failed`) gain optional `correlationId` — one contract family, one commit; no behavior change until T8 publishes it.
**Where**: `src/messaging/dto/video-accepted.dto.ts`
**Depends on**: T4
**Reuses**: existing DTOs
**Requirement**: OBS-32, OBS-33

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] All five DTOs accept/carry the optional field (typecheck + family unit test via the index export)
- [x] Gate check passes: `npm run typecheck && npm test`
- [x] Test count: 1 new unit test passes (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the correlation id to the outcome event contracts`

---

### T6: Consumed DTO family gains the field

**What**: `video-validation-requested.dto.ts` and `processing-queued.dto.ts` gain optional `correlationId` (consumed side).
**Where**: `src/messaging/dto/video-validation-requested.dto.ts`
**Depends on**: T5
**Reuses**: existing DTOs
**Requirement**: OBS-31

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [x] Both DTOs carry the optional field
- [x] Gate check passes: `npm run typecheck && npm test`
- [x] Test count: 1 new unit test passes (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the correlation id to the consumed event contracts`

---

### T7: Publisher enriches from the ALS context

**What**: `RabbitmqEventPublisher` reads `getCorrelationId()` at emit time and sets the field on every outgoing DTO (omitted when undefined) — centralized so no call site can forget it.
**Where**: `src/messaging/rabbitmq-event-publisher.ts`
**Depends on**: T6
**Reuses**: T1 context, T5 DTOs
**Requirement**: OBS-32, OBS-33

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: with a context id set, every emitted DTO carries it; without a context, the field is absent
- [ ] Gate check passes: `npm test`
- [ ] Test count: 4 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): publish outcomes with the correlation id from context`

---

### T8: with-correlation helper

**What**: `with-correlation.ts`: `parseCorrelationId(data?.correlationId) ?? randomUUID()` → `runWithCorrelation` → handler; invalid/absent never fails the message.
**Where**: `src/messaging/with-correlation.ts`
**Depends on**: T7
**Reuses**: T1
**Requirement**: OBS-31, OBS-34

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: valid id flows into the handler context; absent/number/object inputs get a generated id and the handler still runs
- [ ] Gate check passes: `npm test`
- [ ] Test count: 6 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the consumer correlation wrapper`

---

### T9: Validation consumer wrap

**What**: `ValidationConsumer` opens the ALS scope around its `@EventPattern` handler (parse from `VideoValidationRequested`, including it on `VideoAccepted`/`VideoRejected` via T7).
**Where**: `src/validation/validation.consumer.ts`
**Depends on**: T8
**Reuses**: T8 helper, T6 DTOs
**Requirement**: OBS-31, OBS-32

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: consumed message with `w-7` republishes `VideoAccepted` carrying `w-7`; without the field, a generated id flows (asserted via the fake publisher)
- [ ] Gate check passes: `npm test`
- [ ] Test count: 4 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): propagate the correlation id through validation`

---

### T10: Processing consumer wrap

**What**: `ProcessingConsumer` opens the ALS scope around its handler (incl. the shutdown-aware redelivery path — the scope closes when the handler settles, whatever the settlement).
**Where**: `src/processing/processing.consumer.ts`
**Depends on**: T9
**Reuses**: T8 helper
**Requirement**: OBS-31, OBS-33

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: consumed `ProcessingQueued` with `p-3` republishes `ProcessingStarted`/`ProcessingCompleted` carrying `p-3`; shutdown-left-for-redelivery still settles with the context closed
- [ ] Gate check passes: `npm test`
- [ ] Test count: 4 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): propagate the correlation id through processing`

---

### T11: WorkerMetrics registry + families

**What**: Dedicated `Registry`; `fiapx_validation_total{outcome}`, `fiapx_processing_total{outcome}`, `fiapx_processing_duration_seconds` histogram, `fiapx_jobs_inflight{queue}` gauge, HTTP counters; `resetMetrics()`.
**Where**: `src/observability/metrics.ts`
**Depends on**: T10
**Reuses**: prom-client
**Requirement**: OBS-37..40

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: families/labels per spec; reset works; gauge helpers `inflight.track(queue, fn)` release on throw (L-009 — release asserted, not just exclusion)
- [ ] Gate check passes: `npm test`
- [ ] Test count: 7 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): add the fiapx metrics registry and job families`

---

### T12: Validation consumer metrics

**What**: Wrap the handler with `inflight.track('validation', ...)` and `recordValidation(accepted|rejected)` at the existing decision points.
**Where**: `src/validation/validation.consumer.ts`
**Depends on**: T11
**Reuses**: T11 metrics
**Requirement**: OBS-37, OBS-38, OBS-40

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: accepted and rejected paths increment exactly their label; inflight returns to 0 after both a success and a throw
- [ ] Gate check passes: `npm test`
- [ ] Test count: 5 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): instrument validation with outcome counters and inflight gauge`

---

### T13: Processing consumer metrics

**What**: Wrap the handler with `inflight.track('processing', ...)`; on settle record `recordProcessing(completed|failed, elapsedSeconds)` measured from handler start (existing timestamp capture); duration observed on both paths.
**Where**: `src/processing/processing.consumer.ts`
**Depends on**: T12
**Reuses**: T11 metrics
**Requirement**: OBS-39, OBS-40

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit: completed and failed paths increment + observe exactly once each; inflight returns to 0 after a throw (L-009)
- [ ] Gate check passes: `npm test`
- [ ] Test count: 5 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(worker): instrument processing with outcome counters and duration`

---

### T14: /metrics controller + health live

**What**: `GET /metrics` controller serving `registry.metrics()` (unauthenticated — no guard exists); `GET /health/live` (renamed from `live`, all in-repo references updated).
**Where**: `src/health/health.controller.ts`
**Depends on**: T13
**Reuses**: T11 registry
**Requirement**: OBS-37, OBS-41, OBS-42

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] Unit + e2e (T15): both endpoints respond as specified; no in-repo `/live` references remain
- [ ] Gate check passes: `npm test && npm run test:e2e`
- [ ] Test count: 3 new unit tests pass (no silent deletions)

**Tests**: unit
**Gate**: full

**Commit**: `feat(worker): expose metrics and the standardized liveness endpoint`

---

### T15: Observability e2e sweep (real broker)

**What**: Extend the broker e2e suite: publish `VideoValidationRequested` with `correlationId: w-7` → assert published `VideoAccepted` carries `w-7`; four-outcome run (accept+reject+complete+fail) leaves exactly those increments and ≥1 duration observation on `/metrics`; a throwing handler leaves `fiapx_jobs_inflight` at 0 (L-009); message without the field flows with a generated id; `/health` 503 with the broker down while `/health/live` 200 and `/metrics` 200.
**Where**: `test/observability.e2e-spec.ts`
**Depends on**: T14
**Reuses**: existing broker e2e harness (`RABBITMQ_TEST_URL` guard included — spec F's guard stays green)
**Requirement**: OBS-31..42

**Tools**: Skill: `tlc-spec-driven` (per protocol); MCP: NONE

**Done when**:

- [ ] All assertions pass on the real broker
- [ ] Gate check passes: `npm test && npm run test:e2e && npm run lint && npm run typecheck && npm run build`
- [ ] Test count: 9 new e2e tests pass (no silent deletions)

**Tests**: e2e
**Gate**: full

**Commit**: `test(worker): prove the observability slice on a real broker`

---

## Phase Execution Map

```
Phase 1:  T1 -> T2 -> T3 -> T4 -> T5
Phase 2:  T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11
Phase 3:  T11 -> T12 -> T13 -> T14 -> T15
Phase 4:  T15
```

Execution is strictly sequential — one task at a time, gate before commit, one Conventional Commit per task.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1 | 1 module | ✅ Granular |
| T2 | 1 module | ✅ Granular |
| T3 | 1 module | ✅ Granular |
| T4 | wiring pair | ⚠️ Cohesive bootstrap |
| T5 | DTO family (5 files, one pattern) | ⚠️ Splitting forces 5 one-line commits; family is the unit |
| T6 | DTO family (2 files) | ⚠️ Same |
| T7 | 1 publisher | ✅ Granular |
| T8 | 1 helper | ✅ Granular |
| T9 | 1 consumer | ✅ Granular |
| T10 | 1 consumer | ✅ Granular |
| T11 | 1 module | ✅ Granular |
| T12 | 1 consumer instrumentation | ✅ Granular |
| T13 | 1 consumer instrumentation | ✅ Granular |
| T14 | metrics + health endpoints | ⚠️ One observability surface |
| T15 | 1 spec | ✅ Granular (verification slice) |

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | none | none | ✅ Match |
| T2 | T1 | T1 -> T2 | ✅ Match |
| T3 | T2 | T2 -> T3 | ✅ Match |
| T4 | T3 | T3 -> T4 | ✅ Match |
| T5 | T4 | T4 -> T5 | ✅ Match |
| T6 | T5 | T5 -> T6 | ✅ Match |
| T7 | T6 | T6 -> T7 | ✅ Match |
| T8 | T7 | T7 -> T8 | ✅ Match |
| T9 | T8 | T8 -> T9 | ✅ Match |
| T10 | T9 | T9 -> T10 | ✅ Match |
| T11 | T10 | T10 -> T11 | ✅ Match |
| T12 | T11 | T11 -> T12 | ✅ Match |
| T13 | T12 | T12 -> T13 | ✅ Match |
| T14 | T13 | T13 -> T14 | ✅ Match |
| T15 | T14 | T14 -> T15 | ✅ Match |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | observability infra | unit | unit | ✅ OK |
| T2 | observability infra | unit | unit | ✅ OK |
| T3 | config/module | none | none | ✅ OK |
| T4 | config/wiring | none | none (e2e in T15) | ✅ OK |
| T5 | DTO family | unit | unit | ✅ OK |
| T6 | DTO family | unit | unit | ✅ OK |
| T7 | publisher | unit | unit | ✅ OK |
| T8 | helper | unit | unit | ✅ OK |
| T9 | consumer | unit | unit | ✅ OK |
| T10 | consumer | unit | unit | ✅ OK |
| T11 | observability infra | unit | unit | ✅ OK |
| T12 | consumer | unit | unit | ✅ OK |
| T13 | consumer | unit | unit | ✅ OK |
| T14 | controllers | unit + e2e (T15) | unit + full gate | ✅ OK |
| T15 | e2e layer | e2e | e2e | ✅ OK |
