# Processing Worker

The FIAP X service that does the media work. It consumes validation and processing jobs from RabbitMQ, checks each uploaded video with FFprobe, extracts one frame per second with FFmpeg, packs the frames into a ZIP stored in S3-compatible object storage, and reports every outcome back as an event. It makes no lifecycle decisions and serves no user traffic: the [Processing Catalog](https://github.com/tech-challenge-workshop/processing-catalog) owns the request, and this Worker only tells it what happened.

The system overview, the Compose stack, the Kubernetes cluster and the cross-repository decision log (AD-001 onward) live in [`fiap-x-platform`](https://github.com/tech-challenge-workshop/fiap-x-platform). Ownership and exclusions are in [`docs/service-boundary.md`](docs/service-boundary.md).

## Place in the system

```mermaid
flowchart LR
    catalog[Processing Catalog<br/>outbox]
    subgraph rabbit[RabbitMQ]
        vv[[video-validation]]
        pq[[processing]]
        out[[video.accepted<br/>video.rejected<br/>processing.started<br/>processing.completed<br/>processing.failed]]
    end
    worker[Processing Worker<br/>FFprobe + FFmpeg]
    storage[(Object storage<br/>RustFS / S3 API)]

    catalog -- VideoValidationRequested --> vv
    catalog -- ProcessingQueued --> pq
    vv --> worker
    pq --> worker
    worker -- head / download source --> storage
    worker -- upload zips/.../frames.zip --> storage
    worker -- outcome events --> out
    out --> catalog
```

The Worker and the Catalog share no database and no code; they agree only on the JSON of these events. The API hands the user presigned URLs for the source upload and the ZIP download, so the Worker never talks to the user.

## The job pipeline

Both jobs run the same way: skip the message if this replica has already handled its `eventId`, do the work in a temporary directory that is always removed, publish the outcome, then acknowledge.

### Validation (`video-validation` queue)

[`FfprobeVideoValidator`](src/validation/ffprobe-video-validator.ts) checks, in this order:

| Step | Check | Outcome when it fails |
| --- | --- | --- |
| 1 | `HEAD` of `sourceStorageKey`: the object exists, is not empty, and is at most `MAX_SOURCE_BYTES` (500 MB). An oversized object is never downloaded | `VideoRejected` `FORMATO_INVALIDO` |
| 2 | Download to the temp workspace, run `ffprobe -show_format -show_streams` (JSON) within `FFPROBE_TIMEOUT_MS` | unreadable, timeout or bad JSON: `FORMATO_INVALIDO` |
| 3 | FFprobe reports a duration | none reported: `FORMATO_INVALIDO` |
| 4 | Duration at most `MAX_DURATION_SECONDS` (600 s) | `DURACAO_EXCEDIDA` |
| 5 | Container is in the MP4/MOV demuxer family (`mp4`, `mov`, `m4a`, `3gp`, `3g2`, `mj2`) | `FORMATO_INVALIDO` |
| 6 | At least one video stream | `FORMATO_INVALIDO` |
| - | All pass | `VideoAccepted` |

The failure codes are the closed vocabulary shared with the Catalog: `FORMATO_INVALIDO`, `DURACAO_EXCEDIDA`, `PROCESSAMENTO_FALHOU`. There is no size code, so an oversized file is reported as `FORMATO_INVALIDO`. A storage error (endpoint down, access denied) is not a verdict on the file: it propagates and the message is requeued.

### Processing (`processing` queue)

```mermaid
sequenceDiagram
    participant Q as processing queue
    participant W as ProcessingConsumer
    participant P as MediaFramePackager
    participant S as Object storage
    participant O as Outcome queues

    Q->>W: ProcessingQueued
    W->>O: ProcessingStarted (publish failure: requeue, no work)
    W->>P: packageFrames(job)
    P->>S: HEAD zips/{requestId}/{attemptId}/frames.zip
    alt archive already exists (earlier delivery)
        P-->>W: key
    else
        P->>S: download source into temp dir
        P->>P: ffmpeg -vf fps=1 -threads N into frame-00001.jpg ...
        P->>P: ZIP (stored, no compression), entry count must equal frame count
        P->>S: upload frames.zip (application/zip)
        P-->>W: key
    end
    Note over P: temp dir removed on every path
    alt shutdown began meanwhile
        W-->>Q: nothing published, message left unacked
    else packaging threw
        W->>O: ProcessingFailed (PROCESSAMENTO_FALHOU)
        W->>Q: ack
    else
        W->>O: ProcessingCompleted (zipStorageKey)
        W->>Q: ack
    end
```

- **Deterministic key.** The archive lives at `zips/<processingRequestId>/<attemptId>/frames.zip` ([`frameArchiveKey`](src/processing/deterministic-frame-packager.ts)), so a redelivery addresses the same object, and an archive already there is returned without running FFmpeg again.
- **Upload last.** Any failure before the upload leaves no object behind; the key is returned only after the write succeeds.
- **Any packaging error is a job failure.** Unlike validation, a storage or FFmpeg error during processing (non-zero exit, timeout, zero frames, entry-count mismatch) becomes `ProcessingFailed` with `PROCESSAMENTO_FALHOU`, not a retry. A new attempt is the Catalog's decision.
- **Child processes.** FFprobe and FFmpeg run through [`ChildProcessRunner`](src/media/child-process.runner.ts): `spawn` with an argument vector (no shell), a timeout, then `SIGTERM` and `SIGKILL` 2 s later.
- **Temp workspace.** [`TempWorkspace`](src/media/temp-workspace.ts) creates `fiapx-<requestId>-<attemptId|validation>-<random>` under the OS temp directory and removes it in a `finally`; a removal failure is logged, never rethrown.

## Concurrency and scaling

The concurrency model is fiap-x-platform AD-006: FFmpeg runs as a child process, and concurrency comes from a per-queue prefetch, an explicit FFmpeg thread count matched to the CPU limit, and horizontal replicas. No `worker_threads`.

| Lever | Value | Rationale |
| --- | --- | --- |
| Prefetch on `video-validation` | 20 (`PREFETCH_VALIDATION`) | FFprobe on a downloaded file is cheap and mostly I/O |
| Prefetch on `processing` | 1 (`PREFETCH_PROCESSING`) | Extraction saturates the CPU allotment |
| FFmpeg threads | `FFMPEG_THREADS`, default 1, passed as `-threads` | FFmpeg reads the host's cores, not the container's limit, so the value must equal the CPU limit |
| Replicas | stateless, competing on the same queues | Compose `WORKER_REPLICAS`; KEDA in Kubernetes |

- Prefetch is a channel QoS setting (`isGlobalPrefetchCount: false`, which quorum queues require), not a queue argument. An absent, zero or non-integer value falls back to the default: `0` would mean unlimited, and one replica would hold the whole queue unacknowledged and hide its depth from the autoscaler ([`consumer-options.ts`](src/messaging/consumer-options.ts)).
- In Compose, `WORKER_CPUS` sets both the container's `cpus` and `FFMPEG_THREADS` (default 2), and the platform's sizing check fails when they disagree ([Worker sizing](https://github.com/tech-challenge-workshop/fiap-x-platform#worker-sizing), [Worker replicas](https://github.com/tech-challenge-workshop/fiap-x-platform#worker-replicas-and-the-load-test)).
- In the kind cluster each replica gets 1 CPU with `FFMPEG_THREADS=1`, and a KEDA `ScaledObject` ([`k8s/worker-scaling.yaml`](https://github.com/tech-challenge-workshop/fiap-x-platform/blob/main/k8s/worker-scaling.yaml)) scales it from **1 to 5 replicas** on queue length read from the management API (ready plus unacknowledged): target **2 per replica on `processing`** (prefetch 1 plus one waiting) and **20 on `video-validation`**, polled every 5 s ([Local Kubernetes](https://github.com/tech-challenge-workshop/fiap-x-platform#local-kubernetes-kind), AD-018).

### Redelivery, duplicates and shutdown

- **Deterministic outcome ids.** Every published `eventId` is a UUID v5 of `<consumed eventId>:<outcome type>` under a fixed namespace ([`outcome-event-id.ts`](src/messaging/outcome-event-id.ts)). A redelivered message republishes under the same ids and the Catalog drops the repeat by `eventId`; a new attempt arrives as a new message and gets new ids.
- **Local dedup.** [`InMemoryDuplicateChecker`](src/validation/in-memory-duplicate-checker.ts) remembers handled `eventId`s per process, marked only after the outcome is published. It does not survive a restart and is not shared across replicas; the deterministic ids and the idempotent archive key are what make a cross-replica redelivery harmless.
- **Ack after the effect.** A message is acked only after its outcome is published. A failed publish throws, so the message is retried.
- **Shutdown flag.** [`ShutdownSignal`](src/processing/shutdown-signal.ts) is set in `onModuleDestroy`, the first hook of `app.close()`. A processing job that finishes packaging after that publishes no terminal event and leaves its message unacked, so the broker redelivers it once the connection closes. A job that passed the check just before shutdown may publish `ProcessingCompleted` twice; the Catalog absorbs it by `eventId` (accepted window, ROB-07).
- **Known caveat: SIGTERM is not graceful.** [`main.ts`](src/main.ts) does not call `app.enableShutdownHooks()`, so `SIGTERM` (a pod removed on scale-in, `docker stop`) ends the process without running `app.close()`, and the flag above is never set. In-flight jobs are still not lost: their messages were never acked, so RabbitMQ redelivers them to another replica when the connection drops (platform validation V70, K8S-22).

## Messaging

Consumed queues are served by NestJS RMQ microservices with manual acks (`noAck: false`). The queues, their `<queue>.dlq` and the `dead-letter` policy (quorum queues, `delivery-limit: 5`) are owned by the platform's [`rabbitmq/definitions.json`](https://github.com/tech-challenge-workshop/fiap-x-platform/blob/main/rabbitmq/definitions.json) (AD-011, AD-012), not declared with arguments here.

| Consumed queue | Pattern | Handler | Settlement |
| --- | --- | --- | --- |
| `video-validation` | `VideoValidationRequested` | [`ValidationConsumer`](src/validation/validation.consumer.ts) | ack after `VideoAccepted`/`VideoRejected` is published; missing `processingRequestId`: nack without requeue, to `video-validation.dlq` |
| `processing` | `ProcessingQueued` | [`ProcessingConsumer`](src/processing/processing.consumer.ts) | ack after the terminal event is published; missing `processingRequestId` or `attemptId`: nack without requeue, to `processing.dlq`; left unacked when shutdown began |

Failure classification ([`settle-failed-message.ts`](src/messaging/settle-failed-message.ts)):

- **Permanent** (`MessageRejectedError` subclasses): `nack` without requeue, dead-lettered on the first delivery.
- **Non-JSON body**: Nest finds no pattern and nacks it without requeue before any handler runs; it lands in the DLQ (proved in `test/broker.e2e-spec.ts`).
- **Anything else** (storage or broker away, a failed publish): requeued after `RABBITMQ_RETRY_BACKOFF_MS` (default 1000 ms), indefinitely. RabbitMQ 4 does not count explicit requeues toward the delivery limit, so the pause is what prevents a spin.

| Published event | Queue | When | Payload |
| --- | --- | --- | --- |
| `VideoAccepted` | `video.accepted` | validation passed | `eventId`, `processingRequestId`, `occurredAt` |
| `VideoRejected` | `video.rejected` | validation failed | + `failureCode` (`FORMATO_INVALIDO` or `DURACAO_EXCEDIDA`) |
| `ProcessingStarted` | `processing.started` | before any processing work | `eventId`, `processingRequestId`, `attemptId`, `occurredAt` |
| `ProcessingCompleted` | `processing.completed` | archive stored | + `zipStorageKey` |
| `ProcessingFailed` | `processing.failed` | packaging threw | + `failureCode` `PROCESSAMENTO_FALHOU` |

Every outcome carries an optional `correlationId`: the consumed message's id when it is a 1 to 128 character printable ASCII string, otherwise a fresh UUID generated for that message. It is read from the correlation context at publish time and omitted, never `null`, outside a scope (AD-016). Validation outcomes copy the consumed `occurredAt`; processing outcomes stamp the current time. Messages are published persistent, through one `ClientProxy` per outcome queue, and the destination is resolved from the declared event type ([`event-routes.ts`](src/messaging/event-routes.ts)), never inferred from the payload shape.

## Architecture

NestJS modules are wired in [`app.module.ts`](src/app.module.ts). [`configure-app.ts`](src/configure-app.ts) attaches the pino logger and the two RMQ consumers and binds readiness to their connection status; `main.ts` and the broker e2e suites share it.

```text
src/
├── main.ts, configure-app.ts   bootstrap: HTTP app + two RMQ microservices
├── app.module.ts               composition root
├── app.controller.ts           Nest scaffold (GET / answers "Hello World!")
├── validation/                 ValidationConsumer, FfprobeVideoValidator and limits, in-memory duplicate checker
├── processing/                 ProcessingConsumer, MediaFramePackager, archive key, shutdown flag
├── media/                      child-process runner, FFprobe probe, FFmpeg frame extractor, ZIP builder, temp workspace
├── storage/                    ObjectStorage port, S3 and in-memory adapters, adapter selection
├── messaging/                  consumer options, event routes, publisher, outcome ids, failure settlement, correlation wrapper, DTOs
├── observability/              pino config and redaction, correlation context, Prometheus metrics, /metrics, HTTP metrics middleware
├── health/                     /health (readiness) and /health/live, FFmpeg/FFprobe availability probe
└── testing/                    broker-suite guard (test-only; under src/ so the unit Jest config finds it)
```

Key choices:

- **Ports with swappable adapters.** `VideoValidator`, `FramePackager`, `ObjectStorage` and `EventPublisher` are interfaces. `AcceptAllVideoValidator`, `DeterministicFramePackager`, `InMemoryObjectStorage` and `FakeEventPublisher` exist for tests; `test/composition.e2e-spec.ts` asserts which implementation the root binds.
- **Storage adapter by configuration** (AD-005, AD-014). The S3 adapter (path-style, streamed to and from disk) is selected when both `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are set; otherwise the in-memory adapter. The choice is logged at boot and reported in the `/health` body as `storage: "s3"` or `"in-memory"`.
- **Topology owned by the broker** (AD-011, AD-012). `src/messaging/broker-topology.spec.ts` fails if a queue declaration here gains arguments the platform's policy owns.
- **Stored ZIP entries.** JPEG frames do not compress, so the archive uses zlib level 0.

## Tech stack

| Area | Choice |
| --- | --- |
| Runtime | Node.js 22 (`node:22-alpine` image, CI on Node 22), TypeScript ^5.7 |
| Framework | NestJS ^11.0 (`@nestjs/core`, `@nestjs/platform-express`), `@nestjs/microservices` ^11.2 over `amqplib` ^0.10 and `amqp-connection-manager` ^4.1 |
| Media | FFprobe and FFmpeg as child processes; the runtime image installs them with `apk add --no-cache ffmpeg` |
| Archive | `archiver` 8.0.0 |
| Object storage | `@aws-sdk/client-s3` 3.1137.0, RustFS locally |
| Logging | `nestjs-pino` ^5.2, `pino` ^10.3, `pino-http` ^11 |
| Metrics | `prom-client` ^15.1 |
| Tests | Jest ^30, ts-jest, supertest |

### Observability

The conventions shared by all services are fiap-x-platform AD-017.

- **`GET /metrics`** (unauthenticated, own registry, bounded labels only). Every outcome and queue series exists at zero from startup.
  - `fiapx_validation_total{outcome="accepted|rejected"}`
  - `fiapx_processing_total{outcome="completed|failed"}`
  - `fiapx_processing_duration_seconds` histogram, handler start to settlement (buckets 0.5 s to 600 s)
  - `fiapx_jobs_inflight{queue="validation|processing"}`
  - `fiapx_http_requests_total{method,route,status}` (route template or `unmatched`)

  Duplicates, jobs left for redelivery and retried publishes are not counted as outcomes.
- **`GET /health`** (readiness): 200 when both consumers are connected to RabbitMQ and both `ffmpeg -version` and `ffprobe -version` answered at startup; otherwise 503 with a body naming each dependency, for example `{"status":"error","rabbitmq":false,"media":{"ffmpeg":true,"ffprobe":true},"storage":"s3"}`.
- **`GET /health/live`** (liveness): 200 while the process serves, whatever its dependencies.
- **Logs**: one JSON object per line with `service: "processing-worker"`, `timestamp` and, inside a message, `correlationId`. `sourceStorageKey`, `zipStorageKey`, `url`, `email`, `ownerEmail` and the authorization header are removed at the root and up to two levels deep, and storage error messages are written without the key. `/health`, `/health/live` and `/metrics` are kept out of the access log.

## Configuration

Every variable the service code reads:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` (the image sets `3002`) | HTTP port for health and metrics |
| `RABBITMQ_URL` | `amqp://localhost:5672` | Broker for both consumers and all publishers |
| `RABBITMQ_EXCHANGE` | `fiapx-events` | Exchange option passed to the consumer transport |
| `RABBITMQ_VIDEO_VALIDATION_QUEUE` | `video-validation` | Validation queue |
| `RABBITMQ_PROCESSING_QUEUE` | `processing` | Processing queue |
| `PREFETCH_VALIDATION` | `20` | Unacked validation jobs per replica (positive integer, else the default) |
| `PREFETCH_PROCESSING` | `1` | Unacked processing jobs per replica (positive integer, else the default) |
| `RABBITMQ_RETRY_BACKOFF_MS` | `1000` | Pause before a transient failure is requeued (blank means the default) |
| `FFMPEG_THREADS` | `1` | `ffmpeg -threads`; set it to the CPU limit |
| `FFMPEG_TIMEOUT_MS` | `600000` | Frame extraction timeout |
| `FFPROBE_TIMEOUT_MS` | `30000` | Probe timeout |
| `MAX_SOURCE_BYTES` | `524288000` (500 MB) | Largest accepted source |
| `MAX_DURATION_SECONDS` | `600` | Longest accepted duration |
| `STORAGE_ENDPOINT` | `http://storage:9000` | S3 endpoint |
| `STORAGE_BUCKET` | `fiapx` | Bucket for sources and archives |
| `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` | unset | Both set selects the S3 adapter; otherwise in-memory |
| `LOG_LEVEL` | `info` | pino level |

Test-only: `RABBITMQ_TEST_URL` (broker suites), `STORAGE_ENDPOINT` (S3 suite), `CI` (turns a skipped guarded suite into a failure).

## Running

### With the whole system

The normal way is the platform's Compose stack, which builds this repository from the sibling checkout and wires RabbitMQ, RustFS and the other services: see [Running locally](https://github.com/tech-challenge-workshop/fiap-x-platform#running-locally). The Worker's container port 3002 is published on a host port from `3010-3019`.

### Standalone

```sh
npm ci
npm run start:dev      # watch mode; needs RABBITMQ_URL, and storage credentials for real media
npm run build && npm run start:prod
```

`ffmpeg` and `ffprobe` must be on `PATH`; without them `/health` answers 503.

### Tests and checks

```sh
npm run lint           # eslint, zero warnings allowed
npm run typecheck      # tsc --noEmit
npm test               # unit specs under src/
npm run test:cov       # unit specs with coverage
npm run test:e2e       # suites under test/
```

- The media unit specs and several e2e suites run the real `ffmpeg`/`ffprobe` against [`test/fixtures`](test/fixtures/README.md); they fail, not skip, without the binaries.
- Most e2e suites build the real `AppModule` with a fake publisher and need no broker. `test/broker.e2e-spec.ts` and `test/observability.e2e-spec.ts` need a RabbitMQ loaded with the platform's `definitions.json`, through `RABBITMQ_TEST_URL`.
- `test/s3-object-storage.e2e-spec.ts` needs `STORAGE_ENDPOINT` (credentials default to the development `fiapx-dev` / `fiapx-dev-secret`).
- Guarded suites skip on a developer machine when their variable is unset, and fail in CI.

```sh
RABBITMQ_TEST_URL=amqp://guest:guest@localhost:5672 STORAGE_ENDPOINT=http://localhost:9000 npm run test:e2e
```

Do not export `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` for the e2e run: they switch the `AppModule` suites to the S3 adapter.

### Docker

```sh
docker build -t processing-worker .
```

Two stages on `node:22-alpine`: the builder compiles TypeScript; the runtime stage installs `ffmpeg` (which provides `ffprobe`), production dependencies and `dist/`, sets `PORT=3002` and runs `node dist/main`.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests to `main` and pushes to `main`:

- **`quality`**: installs FFmpeg, then lint, typecheck, unit tests with coverage, a RustFS container for the S3 suite, a RabbitMQ service loaded with the platform's broker definitions, `npm run test:e2e`, and the build.
- **`image`** (after `quality`): builds `linux/amd64` and `linux/arm64`; on a push to `main` only, pushes `ghcr.io/tech-challenge-workshop/processing-worker:<sha>` and `:main` with the workflow's `GITHUB_TOKEN`. The kind cluster pulls `:main` (AD-018).

## Links

- Platform: [`fiap-x-platform`](https://github.com/tech-challenge-workshop/fiap-x-platform), decision log [`.specs/STATE.md`](https://github.com/tech-challenge-workshop/fiap-x-platform/blob/main/.specs/STATE.md), architecture foundation [`docs/foudation.md`](https://github.com/tech-challenge-workshop/fiap-x-platform/blob/main/docs/foudation.md)
- Siblings: [`fiap-x-api`](https://github.com/tech-challenge-workshop/fiap-x-api), [`processing-catalog`](https://github.com/tech-challenge-workshop/processing-catalog), [`notification-service`](https://github.com/tech-challenge-workshop/notification-service)
- This repository: [`docs/service-boundary.md`](docs/service-boundary.md), [`docs/ROADMAP.md`](docs/ROADMAP.md), [`.specs/LESSONS.md`](.specs/LESSONS.md)
- Feature specs: [real media processing](.specs/features/real-media-processing/spec.md), [full lifecycle](.specs/features/full-lifecycle/spec.md), [service robustness](.specs/features/service-robustness/spec.md), [catalog messaging hardening](.specs/features/catalog-messaging-hardening/spec.md), [observability](.specs/features/observability/spec.md), [CI pipeline](.specs/features/ci-pipeline/spec.md), [local Docker integration](.specs/features/local-docker-integration/spec.md), [initial vertical slice](.specs/features/initial-vertical-slice/spec.md)
