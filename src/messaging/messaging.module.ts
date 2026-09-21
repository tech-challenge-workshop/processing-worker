import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EVENT_PUBLISHER } from './event-publisher.interface';
import { EVENT_ROUTES, WORKER_EVENT_TYPES } from './event-routes';
import { RabbitmqEventPublisher } from './rabbitmq-event-publisher';
import { RabbitmqHealthService } from './rabbitmq-health.service';

const QUEUES: Record<string, string> = {
  RMQ_VIDEO_ACCEPTED_CLIENT: 'video.accepted',
  RMQ_VIDEO_REJECTED_CLIENT: 'video.rejected',
  RMQ_PROCESSING_STARTED_CLIENT: 'processing.started',
  RMQ_PROCESSING_COMPLETED_CLIENT: 'processing.completed',
  RMQ_PROCESSING_FAILED_CLIENT: 'processing.failed',
};

/**
 * Derived from EVENT_ROUTES rather than written out again, so a route whose
 * client token has no queue cannot be registered and cannot silently resolve
 * to nothing at boot.
 */
const clientRegistrations = WORKER_EVENT_TYPES.map((type) => {
  const token = EVENT_ROUTES[type].client;
  const queue = QUEUES[token];

  if (!queue) {
    throw new Error(`No queue configured for client token ${token}`);
  }

  return {
    name: token,
    transport: Transport.RMQ as const,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue,
      noAck: true,
      persistent: true,
      queueOptions: {
        durable: true,
      },
    },
  };
});

@Module({
  imports: [ClientsModule.register(clientRegistrations)],
  providers: [
    RabbitmqHealthService,
    {
      provide: EVENT_PUBLISHER,
      useClass: RabbitmqEventPublisher,
    },
  ],
  exports: [RabbitmqHealthService, ClientsModule, EVENT_PUBLISHER],
})
export class MessagingModule {}
