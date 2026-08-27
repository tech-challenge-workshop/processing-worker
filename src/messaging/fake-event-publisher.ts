import { Injectable } from '@nestjs/common';
import { EventPublisher } from './event-publisher.interface';
import { VideoAcceptedDto } from './dto/video-accepted.dto';

@Injectable()
export class FakeEventPublisher implements EventPublisher {
  private readonly events: VideoAcceptedDto[] = [];
  private nextResult = true;

  async publish(event: VideoAcceptedDto): Promise<boolean> {
    this.events.push(event);
    return this.nextResult;
  }

  setNextResult(result: boolean): void {
    this.nextResult = result;
  }

  get publishedEvents(): readonly VideoAcceptedDto[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
    this.nextResult = true;
  }
}
