import { Injectable } from '@nestjs/common';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { FramePackager } from './frame-packager.interface';

/**
 * The single definition of where a job's archive lives. Derived from
 * processingRequestId and attemptId, so a technical redelivery addresses the
 * same object; the real packager and this test double share it.
 */
export function frameArchiveKey(
  job: Pick<ProcessingQueuedDto, 'processingRequestId' | 'attemptId'>,
): string {
  return `local/${job.processingRequestId}/${job.attemptId}/frames.zip`;
}

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
    return Promise.resolve(frameArchiveKey(job));
  }
}
