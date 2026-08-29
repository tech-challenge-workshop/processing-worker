import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { ProcessingModule } from './processing/processing.module';
import { ValidationModule } from './validation/validation.module';

@Module({
  imports: [HealthModule, ProcessingModule, ValidationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
