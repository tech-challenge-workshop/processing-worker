import { Inject, Injectable } from '@nestjs/common';
import { ChildProcessRunner } from './child-process.runner';

/**
 * What FFprobe could determine about a local file. The probe reports facts;
 * whether they make the file acceptable is the validator's decision.
 */
// SPEC_DEVIATION: design.md's data model declares every field of ProbeResult
// required, while its component notes say the probe returns
// `{ readable: false }` on failure.
// Reason: a discriminated union states both at once, so an unreadable result
// carries no fields that could be mistaken for real ones.
export type ProbeResult =
  | { readable: false }
  | {
      readable: true;
      /** `format.format_name` split on ',' */
      formatNames: string[];
      /** Absent when FFprobe reports none; never defaulted to zero. */
      durationSeconds?: number;
      hasVideoStream: boolean;
    };

export interface FfprobeOptions {
  binary: string;
  timeoutMs: number;
}

export const FFPROBE_OPTIONS = 'FFPROBE_OPTIONS';

export const DEFAULT_FFPROBE_TIMEOUT_MS = 30000;

export function ffprobeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FfprobeOptions {
  const timeoutMs = Number(env.FFPROBE_TIMEOUT_MS);
  return {
    binary: 'ffprobe',
    timeoutMs:
      Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_FFPROBE_TIMEOUT_MS,
  };
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string }[];
}

/** Reports container family, duration and video presence of a local file. */
@Injectable()
export class FfprobeProbe {
  constructor(
    private readonly runner: ChildProcessRunner,
    @Inject(FFPROBE_OPTIONS) private readonly options: FfprobeOptions,
  ) {}

  async probe(path: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await this.runner.run(
        this.options.binary,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          path,
        ],
        { timeoutMs: this.options.timeoutMs },
      ));
    } catch {
      // Non-zero exit, timeout or a binary that cannot start: a file FFprobe
      // cannot read within the limit is not processable.
      return { readable: false };
    }

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      return { readable: false };
    }

    const formatName = output.format?.format_name;
    const duration = Number(output.format?.duration);
    return {
      readable: true,
      formatNames: formatName ? formatName.split(',') : [],
      ...(output.format?.duration !== undefined && Number.isFinite(duration)
        ? { durationSeconds: duration }
        : {}),
      hasVideoStream: (output.streams ?? []).some(
        (stream) => stream.codec_type === 'video',
      ),
    };
  }
}
