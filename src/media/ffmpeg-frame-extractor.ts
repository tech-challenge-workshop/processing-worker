import { Inject, Injectable } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChildProcessRunner } from './child-process.runner';

export interface FfmpegOptions {
  binary: string;
  /** Passed as `-threads`; never left to FFmpeg's host core detection. */
  threads: number;
  timeoutMs: number;
}

export const FFMPEG_OPTIONS = 'FFMPEG_OPTIONS';

export const DEFAULT_FFMPEG_THREADS = 1;
export const DEFAULT_FFMPEG_TIMEOUT_MS = 600000;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function ffmpegOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FfmpegOptions {
  return {
    binary: 'ffmpeg',
    threads: positiveInteger(env.FFMPEG_THREADS, DEFAULT_FFMPEG_THREADS),
    timeoutMs: positiveInteger(
      env.FFMPEG_TIMEOUT_MS,
      DEFAULT_FFMPEG_TIMEOUT_MS,
    ),
  };
}

/** Zero padding keeps lexical order equal to temporal order. */
const FRAME_PATTERN = 'frame-%05d.jpg';
const FRAME_NAME = /^frame-\d{5}\.jpg$/;

/**
 * Writes one JPEG per second of video into a directory, with an explicit
 * thread count (AD-006): FFmpeg reads the host's cores, not the container's
 * CPU limit.
 */
@Injectable()
export class FfmpegFrameExtractor {
  constructor(
    private readonly runner: ChildProcessRunner,
    @Inject(FFMPEG_OPTIONS) private readonly options: FfmpegOptions,
  ) {}

  /** The frame paths, in temporal order. Rejects on non-zero exit or timeout. */
  async extract(sourcePath: string, destinationDir: string): Promise<string[]> {
    await this.runner.run(
      this.options.binary,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        sourcePath,
        '-vf',
        'fps=1',
        '-threads',
        String(this.options.threads),
        join(destinationDir, FRAME_PATTERN),
      ],
      { timeoutMs: this.options.timeoutMs },
    );

    // Read back what FFmpeg actually wrote rather than what was expected.
    const names = (await readdir(destinationDir))
      .filter((name) => FRAME_NAME.test(name))
      .sort();
    return names.map((name) => join(destinationDir, name));
  }
}
