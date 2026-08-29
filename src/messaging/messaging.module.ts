import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EVENT_PUBLISHER } from './event-publisher.interface';
import { RabbitmqEventPublisher } from './rabbitmq-event-publisher';
import { RabbitmqHealthService } from './rabbitmq-health.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'RMQ_CLIENT',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
          queue: process.env.RABBITMQ_PUBLISHER_QUEUE ?? 'worker-publisher',
          noAck: false,
          persistent: true,
          wildcards: true,
          exchange: process.env.RABBITMQ_EXCHANGE ?? 'fiapx-events',
          queueOptions: {
            durable: true,
          },
        },
      },
    ]),
  ],
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
