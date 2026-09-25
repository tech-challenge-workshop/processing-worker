import { Inject, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { FfprobeProbe } from '../media/ffprobe-probe';
import { TempWorkspace } from '../media/temp-workspace';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import { ValidationOutcome, VideoValidator } from './video-validator.interface';

export interface ValidationLimits {
  maxSourceBytes: number;
  maxDurationSeconds: number;
}

export const VALIDATION_LIMITS = 'VALIDATION_LIMITS';

/** 500 MB and 10 minutes, fixed by `docs/foudation.md`. */
export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  maxSourceBytes: 524288000,
  maxDurationSeconds: 600,
};

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function validationLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ValidationLimits {
  return {
    maxSourceBytes: positive(
      env.MAX_SOURCE_BYTES,
      DEFAULT_VALIDATION_LIMITS.maxSourceBytes,
    ),
    maxDurationSeconds: positive(
      env.MAX_DURATION_SECONDS,
      DEFAULT_VALIDATION_LIMITS.maxDurationSeconds,
    ),
  };
}

/** What FFprobe reports for the MP4/MOV demuxer family. */
const MP4_MOV_FAMILY = new Set(['mp4', 'mov', 'm4a', '3gp', '3g2', 'mj2']);

const INVALID: ValidationOutcome = {
  accepted: false,
  failureCode: 'FORMATO_INVALIDO',
};

/**
 * Decides acceptance from the object's reported size and an FFprobe probe of
 * the downloaded file. Order is part of the contract: size from `head` first,
 * so an oversized object is rejected without being transferred; then
 * download and probe.
 *
 * A storage failure is not a verdict on the file: it propagates, so the
 * consumer requeues instead of blaming the user's video for our outage.
 */
@Injectable()
export class FfprobeVideoValidator implements VideoValidator {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly probe: FfprobeProbe,
    private readonly workspace: TempWorkspace,
    @Inject(VALIDATION_LIMITS) private readonly limits: ValidationLimits,
  ) {}

  async validate(job: VideoValidationRequestedDto): Promise<ValidationOutcome> {
    const head = await this.storage.head(job.sourceStorageKey);
    // Absent, empty or over the size limit: nothing to probe, and nothing
    // worth transferring. The closed vocabulary has no size code, and
    // FORMATO_INVALIDO is imprecise but never false (spec assumption).
    if (
      !head ||
      head.sizeBytes === 0 ||
      head.sizeBytes > this.limits.maxSourceBytes
    ) {
      return INVALID;
    }

    return this.workspace.withWorkspace(
      { processingRequestId: job.processingRequestId },
      async (dir) => {
        const sourcePath = join(dir, 'source');
        await this.storage.download(job.sourceStorageKey, sourcePath);
        const probe = await this.probe.probe(sourcePath);

        if (!probe.readable) return INVALID;
        // A duration FFprobe cannot report cannot be shown to be within the
        // limit, so it is not accepted.
        if (probe.durationSeconds === undefined) return INVALID;
        // Checked before the container only because a long valid video is
        // the more informative rejection.
        if (probe.durationSeconds > this.limits.maxDurationSeconds) {
          return { accepted: false, failureCode: 'DURACAO_EXCEDIDA' };
        }
        if (!probe.formatNames.some((name) => MP4_MOV_FAMILY.has(name))) {
          return INVALID;
        }
        if (!probe.hasVideoStream) return INVALID;
        return { accepted: true };
      },
    );
  }
}
