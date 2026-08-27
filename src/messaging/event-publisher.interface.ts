import { VideoAcceptedDto } from './dto/video-accepted.dto';

export interface EventPublisher {
  publish(event: VideoAcceptedDto): Promise<boolean>;
}
