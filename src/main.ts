import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { combineLatest, map } from 'rxjs';
import { AppModule } from './app.module';
import { RabbitmqHealthService } from './messaging/rabbitmq-health.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const rabbitmqUrl = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
  const exchange = process.env.RABBITMQ_EXCHANGE ?? 'fiapx-events';
  const validationQueue =
    process.env.RABBITMQ_VIDEO_VALIDATION_QUEUE ?? 'video-validation';
  const processingQueue = process.env.RABBITMQ_PROCESSING_QUEUE ?? 'processing';

  const validationServer = app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: validationQueue,
      noAck: false,
      wildcards: true,
      exchange,
      queueOptions: { durable: true },
    },
  });

  const processingServer = app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: processingQueue,
      noAck: false,
      wildcards: true,
      exchange,
      queueOptions: { durable: true },
    },
  });

  const health = app.get(RabbitmqHealthService);
  combineLatest([validationServer.status, processingServer.status])
    .pipe(
      map(
        ([validationStatus, processingStatus]) =>
          validationStatus === 'connected' && processingStatus === 'connected',
      ),
    )
    .subscribe((connected) => health.setConnected(connected));

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
