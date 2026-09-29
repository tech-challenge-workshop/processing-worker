import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/observability.module';
import { ProcessingModule } from './processing/processing.module';
import { StorageModule } from './storage/storage.module';
import { ValidationModule } from './validation/validation.module';

@Module({
  imports: [
    ObservabilityModule,
    HealthModule,
    ProcessingModule,
    StorageModule,
    ValidationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
