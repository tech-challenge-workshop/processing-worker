# Processing Worker

Processing Worker validates uploaded videos, extracts one frame per second with FFprobe/FFmpeg, creates the ZIP frame package, stores media objects in S3, and reports results asynchronously.

See [the service boundary](docs/service-boundary.md) for ownership, integrations, and explicit exclusions.

## Foundation scope

This repository intentionally contains no NestJS, FFmpeg, S3, or RabbitMQ implementation yet. The approved system architecture is in the workspace's `docs/foudation.md`.
