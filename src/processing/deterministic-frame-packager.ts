import { Injectable } from '@nestjs/common';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { FramePackager } from './frame-packager.interface';

/**
 * Returns the deterministic key for a job without producing any package.
 *
 * The key is derived from processingRequestId and attemptId, so a technical
 * redelivery addresses the same object rather than creating a second one.
 * S4 replaces this with real frame extraction.
 */
@Injectable()
export class DeterministicFramePackager implements FramePackager {
  packageFrames(job: ProcessingQueuedDto): Promise<string> {
    return Promise.resolve(
      `local/${job.processingRequestId}/${job.attemptId}/frames.zip`,
    );
  }
}
