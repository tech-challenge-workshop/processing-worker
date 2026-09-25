import {
  Controller,
  Get,
  Inject,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RabbitmqHealthService } from '../messaging/rabbitmq-health.service';
import {
  FfmpegAvailabilityIndicator,
  MediaCapability,
} from './ffmpeg-availability.indicator';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';

interface ReadinessBody {
  status: string;
  rabbitmq: boolean;
  media: MediaCapability;
  storage: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: RabbitmqHealthService,
    private readonly media: FfmpegAvailabilityIndicator,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Readiness: the broker is connected and both media binaries answered at
   * startup. The body names each dependency, so an operator sees which one
   * is missing without reading logs, and names the storage adapter in use.
   */
  @Get()
  @HttpCode(200)
  async getHealth(): Promise<ReadinessBody> {
    const rabbitmq = this.health.isHealthy();
    const mediaReady = await this.media.isHealthy();
    const media = this.media.capabilities();
    const storage = this.storage.adapterName;
    if (!rabbitmq || !mediaReady) {
      throw new ServiceUnavailableException({
        status: 'error',
        rabbitmq,
        media,
        storage,
      });
    }
    return { status: 'ok', rabbitmq, media, storage };
  }

  /** Liveness: the process answers. It depends on nothing else. */
  @Get('live')
  @HttpCode(200)
  getLiveness(): { status: string } {
    return { status: 'ok' };
  }
}
