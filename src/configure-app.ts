import { INestApplication } from '@nestjs/common';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { combineLatest, map } from 'rxjs';
import { consumerOptions } from './messaging/consumer-options';
import { RabbitmqHealthService } from './messaging/rabbitmq-health.service';

/**
 * Composes the Worker on a created app: the pino logger, both RMQ consumers,
 * and readiness bound to their broker status. main.ts and the broker e2e
 * suites share it, so the tests run the Worker's own wiring.
 */
export function configureApp(
  app: INestApplication,
  consumers = consumerOptions(),
): void {
  // useLogger replaces Nest's global logger, which the two RMQ microservices
  // connected below share with the HTTP app.
  app.useLogger(app.get(Logger));

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
}
