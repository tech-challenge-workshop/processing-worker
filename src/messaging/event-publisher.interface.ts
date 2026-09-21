import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';
import { WorkerEventType } from './event-routes';

export type WorkerEvent = VideoAcceptedDto | ProcessingCompletedDto;

export interface EventPublisher {
  /**
   * The caller states what it is publishing. The publisher never infers the
   * type from the payload: several event types share a shape, so structural
   * discrimination would route them to the wrong queue and report success.
   */
  publish(type: WorkerEventType, event: WorkerEvent): Promise<boolean>;
}

export const EVENT_PUBLISHER = 'EVENT_PUBLISHER';
