import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChildProcessRunner } from '../media/child-process.runner';

/** Where the two binaries are looked up; the names resolve through PATH. */
export interface MediaBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export const MEDIA_BINARIES = 'MEDIA_BINARIES';

export const DEFAULT_MEDIA_BINARIES: MediaBinaries = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
};

export interface MediaCapability {
  ffmpeg: boolean;
  ffprobe: boolean;
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * Reports whether FFmpeg and FFprobe answer. Probed once while the module
 * initialises and cached: an image without the binaries is a packaging
 * fault that no later request can fix, and it must keep the pod out of
 * traffic instead of failing every job as if the media were at fault.
 */
@Injectable()
export class FfmpegAvailabilityIndicator implements OnModuleInit {
  private readonly logger = new Logger(FfmpegAvailabilityIndicator.name);
  private capability: MediaCapability = { ffmpeg: false, ffprobe: false };

  constructor(
    private readonly runner: ChildProcessRunner,
    @Inject(MEDIA_BINARIES) private readonly binaries: MediaBinaries,
  ) {}

  async onModuleInit(): Promise<void> {
    const [ffmpeg, ffprobe] = await Promise.all([
      this.answers(this.binaries.ffmpeg),
      this.answers(this.binaries.ffprobe),
    ]);
    this.capability = { ffmpeg, ffprobe };
    if (!ffmpeg || !ffprobe) {
      this.logger.error(
        `Media binaries unavailable: ffmpeg=${ffmpeg} ffprobe=${ffprobe}; readiness will fail`,
      );
    }
  }

  capabilities(): MediaCapability {
    return { ...this.capability };
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.capability.ffmpeg && this.capability.ffprobe);
  }

  private async answers(binary: string): Promise<boolean> {
    try {
      await this.runner.run(binary, ['-version'], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }
}
