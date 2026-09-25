import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ChildProcessRunner } from '../media/child-process.runner';
import {
  DEFAULT_MEDIA_BINARIES,
  FfmpegAvailabilityIndicator,
  MEDIA_BINARIES,
} from './ffmpeg-availability.indicator';
import { HealthController } from './health.controller';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
  providers: [
    ChildProcessRunner,
    FfmpegAvailabilityIndicator,
    { provide: MEDIA_BINARIES, useValue: DEFAULT_MEDIA_BINARIES },
  ],
})
export class HealthModule {}
