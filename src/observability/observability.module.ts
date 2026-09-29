import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CorrelationContext, correlationContext } from './correlation-context';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import {
  buildRootLoggerConfig,
  LOG_DESTINATION,
  type LogDestination,
} from './logger.config';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [
    // SPEC_DEVIATION: tasks.md names `LoggerModule.forRoot(rootConfig)`.
    // Reason: forRootAsync builds the config when the app is created, not when
    // this file is imported, so a LOG_LEVEL set by a test bootstrap applies.
    LoggerModule.forRootAsync({
      providers: [{ provide: LOG_DESTINATION, useValue: null }],
      inject: [LOG_DESTINATION],
      useFactory: (destination: LogDestination) => {
        const { pinoHttp } = buildRootLoggerConfig(correlationContext);
        return {
          pinoHttp: destination === null ? pinoHttp : [pinoHttp, destination],
        };
      },
    }),
  ],
  // The process-wide instance, so injected consumers and the pino mixin read
  // the same ALS store.
  providers: [{ provide: CorrelationContext, useValue: correlationContext }],
  controllers: [MetricsController],
  exports: [CorrelationContext],
})
export class ObservabilityModule implements NestModule {
  // Every route, health and metrics included: they are counted, and only
  // kept out of the access log.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
