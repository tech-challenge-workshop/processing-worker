import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';

/**
 * Produces the frame package for a queued job and returns its storage key.
 *
 * S4 implements this with FFmpeg and object storage. Until then the only
 * implementation returns the deterministic key without producing anything,
 * which is what the local integration flow already assumed.
 */
export interface FramePackager {
  packageFrames(job: ProcessingQueuedDto): Promise<string>;
}

export const FRAME_PACKAGER = 'FRAME_PACKAGER';
