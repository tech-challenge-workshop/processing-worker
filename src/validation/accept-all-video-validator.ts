import { Injectable } from '@nestjs/common';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import {
  ValidationOutcome,
  VideoValidator,
} from './video-validator.interface';

/**
 * Accepts every video, without inspecting it.
 *
 * The name is the warning: a green suite proves the rejection path is wired,
 * not that any real validation happens. S4 replaces this with an FFprobe
 * implementation that enforces the MP4/MOV, 500 MB and 10 minute rules.
 */
@Injectable()
export class AcceptAllVideoValidator implements VideoValidator {
  validate(_job: VideoValidationRequestedDto): Promise<ValidationOutcome> {
    return Promise.resolve({ accepted: true });
  }
}
