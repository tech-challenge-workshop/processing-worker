import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';

export interface EventPublisher {
  publish(event: VideoAcceptedDto | ProcessingCompletedDto): Promise<boolean>;
}

export const EVENT_PUBLISHER = 'EVENT_PUBLISHER';
