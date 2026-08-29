import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RabbitmqHealthService } from '../messaging/rabbitmq-health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: RabbitmqHealthService) {}

  @Get()
  @HttpCode(200)
  getHealth(): { status: string; rabbitmq: boolean } {
    const rabbitmq = this.health.isHealthy();
    if (!rabbitmq) {
      throw new ServiceUnavailableException({
        status: 'error',
        rabbitmq: false,
      });
    }
    return { status: 'ok', rabbitmq: true };
  }
}
