import { RmqOptions, Transport } from '@nestjs/microservices';

/**
 * Documented prefetch defaults (RM-14). FFprobe on a downloaded file is cheap
 * and mostly I/O, so validation holds 20; extraction saturates its CPU
 * allotment, so processing holds 1.
 */
export const DEFAULT_PREFETCH_VALIDATION = 20;
export const DEFAULT_PREFETCH_PROCESSING = 1;

/**
 * A configured prefetch, or the default when the value is absent or not a
 * positive integer. Nest's own default is `0`, which RabbitMQ reads as
 * unlimited: one replica would hold the whole queue unacknowledged and hide
 * its depth from the autoscaler, so `0` is never passed through.
 */
export function prefetchFrom(
  configured: string | undefined,
  fallback: number,
): number {
  const value = Number(configured);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

type Env = Record<string, string | undefined>;

/**
 * The options both consumed queues are served with.
 *
 * `prefetchCount` is a consumer setting on the channel, not a queue argument,
 * so it leaves the topology the broker policy owns untouched (AD-011).
 * `isGlobalPrefetchCount` stays false: quorum queues (AD-012) do not support
 * a channel-global QoS.
 */
export function consumerOptions(env: Env = process.env): {
  validation: RmqOptions;
  processing: RmqOptions;
} {
  const url = env.RABBITMQ_URL ?? 'amqp://localhost:5672';
  const exchange = env.RABBITMQ_EXCHANGE ?? 'fiapx-events';

  const consumer = (queue: string, prefetchCount: number): RmqOptions => ({
    transport: Transport.RMQ,
    options: {
      urls: [url],
      queue,
      noAck: false,
      wildcards: true,
      exchange,
      queueOptions: { durable: true },
      prefetchCount,
      isGlobalPrefetchCount: false,
    },
  });

  return {
    validation: consumer(
      env.RABBITMQ_VIDEO_VALIDATION_QUEUE ?? 'video-validation',
      prefetchFrom(env.PREFETCH_VALIDATION, DEFAULT_PREFETCH_VALIDATION),
    ),
    processing: consumer(
      env.RABBITMQ_PROCESSING_QUEUE ?? 'processing',
      prefetchFrom(env.PREFETCH_PROCESSING, DEFAULT_PREFETCH_PROCESSING),
    ),
  };
}
