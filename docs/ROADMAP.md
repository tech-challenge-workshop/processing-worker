# Processing Worker roadmap specification

## Outcome

Deliver horizontally scalable, asynchronous validation and frame-package generation for uploaded videos.

## Delivery phases

1. **Bootstrap and quality**: restore dependencies, make Nest gates green, and establish CI.
2. **Validation job**: consume validation requests, inspect the real file with FFprobe, and publish accepted or rejected outcomes with safe failure codes.
3. **Processing job**: consume queued work, publish start, read the source object, extract one frame per second with FFmpeg, and create a ZIP package.
4. **Storage and events**: use deterministic object keys, store the ZIP, publish completed/failed outcomes with publisher confirms, and acknowledge only after the durable effect.
5. **Operations**: add container image tooling, a bounded concurrency envelope, queue-depth autoscaling support, observability, and integration tests against RabbitMQ and S3-compatible storage.

## Acceptance boundaries

- The Worker does not make Processing Request lifecycle decisions or authenticate users.
- Validation and processing failures end with safe failure codes; no automatic business retry is introduced.
- A repeated delivery does not create an additional processing attempt or external effect.

## Done

WHEN a queued valid video is processed THEN the Worker SHALL create and store one ZIP frame package and publish a versioned completion event; IF validation or processing fails THEN it SHALL publish the defined safe failure outcome.
