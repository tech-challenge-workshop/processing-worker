import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { combineLatest, map } from 'rxjs';
import { AppModule } from './app.module';
import { consumerOptions } from './messaging/consumer-options';
import { RabbitmqHealthService } from './messaging/rabbitmq-health.service';

async function bootstrap() {
  // Buffer until the pino logger is resolved, so bootstrap lines are JSON
  // too. useLogger replaces Nest's global logger, which the two RMQ
  // microservices connected below share with the HTTP app.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const consumers = consumerOptions();

  const validationServer = app.connectMicroservice<MicroserviceOptions>(
    consumers.validation,
  );

  const processingServer = app.connectMicroservice<MicroserviceOptions>(
    consumers.processing,
  );

  const health = app.get(RabbitmqHealthService);
  combineLatest([validationServer.status, processingServer.status])
    .pipe(
      map(
        ([validationStatus, processingStatus]) =>
          validationStatus === 'connected' && processingStatus === 'connected',
      ),
    )
    .subscribe((connected) => health.setConnected(connected));

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
  app.flushLogs();
}
void bootstrap();
