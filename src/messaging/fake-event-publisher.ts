import { Injectable } from '@nestjs/common';
import { EventPublisher } from './event-publisher.interface';
import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';

@Injectable()
export class FakeEventPublisher implements EventPublisher {
  private readonly events: (VideoAcceptedDto | ProcessingCompletedDto)[] = [];
  private nextResult = true;

  publish(event: VideoAcceptedDto | ProcessingCompletedDto): Promise<boolean> {
    this.events.push(event);
    return Promise.resolve(this.nextResult);
  }

  setNextResult(result: boolean): void {
    this.nextResult = result;
  }

  get publishedEvents(): readonly (
    VideoAcceptedDto | ProcessingCompletedDto
  )[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
    this.nextResult = true;
  }
}
