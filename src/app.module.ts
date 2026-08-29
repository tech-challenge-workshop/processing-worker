import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { ValidationModule } from './validation/validation.module';

@Module({
  imports: [HealthModule, ValidationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
