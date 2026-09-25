import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RabbitmqHealthService } from '../messaging/rabbitmq-health.service';
import {
  FfmpegAvailabilityIndicator,
  MediaCapability,
} from './ffmpeg-availability.indicator';

interface ReadinessBody {
  status: string;
  rabbitmq: boolean;
  media: MediaCapability;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: RabbitmqHealthService,
    private readonly media: FfmpegAvailabilityIndicator,
  ) {}

  /**
   * Readiness: the broker is connected and both media binaries answered at
   * startup. The body names each dependency, so an operator sees which one
   * is missing without reading logs.
   */
  @Get()
  @HttpCode(200)
  async getHealth(): Promise<ReadinessBody> {
    const rabbitmq = this.health.isHealthy();
    const mediaReady = await this.media.isHealthy();
    const media = this.media.capabilities();
    if (!rabbitmq || !mediaReady) {
      throw new ServiceUnavailableException({
        status: 'error',
        rabbitmq,
        media,
      });
    }
    return { status: 'ok', rabbitmq, media };
  }

  /** Liveness: the process answers. It depends on nothing else. */
  @Get('live')
  @HttpCode(200)
  getLiveness(): { status: string } {
    return { status: 'ok' };
  }
}
