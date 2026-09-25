import { Inject, Injectable } from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { FfmpegFrameExtractor } from '../media/ffmpeg-frame-extractor';
import { TempWorkspace } from '../media/temp-workspace';
import { ZipBuilder } from '../media/zip-builder';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';
import { frameArchiveKey } from './deterministic-frame-packager';
import { FramePackager } from './frame-packager.interface';

/**
 * Turns a queued job into exactly one stored archive of one frame per second.
 *
 * Idempotent through storage alone (AD-008): an archive already at the
 * deterministic key is the result of an earlier delivery, so it is returned
 * without extracting again. The upload is the last step, so a failure
 * anywhere earlier leaves no object at all rather than a partial one, and
 * the key is returned only once the write is confirmed.
 */
@Injectable()
export class MediaFramePackager implements FramePackager {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly extractor: FfmpegFrameExtractor,
    private readonly zip: ZipBuilder,
    private readonly workspace: TempWorkspace,
  ) {}

  async packageFrames(job: ProcessingQueuedDto): Promise<string> {
    const key = frameArchiveKey(job);
    if (await this.storage.head(key)) {
      return key;
    }

    return this.workspace.withWorkspace(
      {
        processingRequestId: job.processingRequestId,
        attemptId: job.attemptId,
      },
      async (dir) => {
        const sourcePath = join(dir, 'source');
        await this.storage.download(job.sourceStorageKey, sourcePath);

        const framesDir = join(dir, 'frames');
        await mkdir(framesDir);
        const frames = await this.extractor.extract(sourcePath, framesDir);

        const archivePath = join(dir, 'frames.zip');
        const entries = await this.zip.build(frames, archivePath);
        if (entries !== frames.length) {
          throw new Error(
            `Archive holds ${entries} entries for ${frames.length} extracted frames`,
          );
        }

        await this.storage.upload(key, archivePath, 'application/zip');
        return key;
      },
    );
  }
}
