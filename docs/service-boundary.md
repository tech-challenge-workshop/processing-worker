# Processing Worker service boundary

## Owns

- Asynchronous consumption of video-validation and processing jobs.
- Actual file inspection with FFprobe before work is queued.
- FFmpeg frame extraction at the approved sampling rate and ZIP package creation.
- Reading source videos and storing ZIP packages in private S3-compatible object storage.
- Publication of versioned validation and processing result events after work is complete.
- Its own concurrency envelope: bounded `prefetchCount` per queue and an explicit FFmpeg thread count matched to the container CPU limit.

## Primary technology context

NestJS and TypeScript, FFprobe, FFmpeg, S3-compatible object storage (RustFS locally, since fiap-x-platform AD-014 replaced MinIO), and RabbitMQ.

## Integrations

- Consumes versioned validation and processing jobs from RabbitMQ.
- Reads and writes private media objects in object storage through deterministic storage keys.
- Reports accepted, rejected, started, completed, and failed outcomes to Processing Catalog through RabbitMQ.

## Does not own

- Processing Request lifecycle decisions or persistence.
- HTTP access, user authentication, or ownership checks.
- Email delivery or notification delivery records.
- Shared database tables with other services.

## Source of truth

This foundation reflects `docs/foudation.md` and the reference documents in the `fiap-x-platform` repository. It is not a product implementation.
