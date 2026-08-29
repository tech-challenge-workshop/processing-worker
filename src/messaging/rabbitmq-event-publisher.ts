import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, map, of } from 'rxjs';
import { EventPublisher } from './event-publisher.interface';
import { ProcessingCompletedDto } from './dto/processing-completed.dto';
import { VideoAcceptedDto } from './dto/video-accepted.dto';

@Injectable()
export class RabbitmqEventPublisher implements EventPublisher {
  constructor(
    @Inject('RMQ_VIDEO_ACCEPTED_CLIENT')
    private readonly videoAcceptedClient: ClientProxy,
    @Inject('RMQ_PROCESSING_COMPLETED_CLIENT')
    private readonly processingCompletedClient: ClientProxy,
  ) {}

  async publish(
    event: VideoAcceptedDto | ProcessingCompletedDto,
  ): Promise<boolean> {
    const pattern = this.getPattern(event);
    const client =
      'zipStorageKey' in event
        ? this.processingCompletedClient
        : this.videoAcceptedClient;
    return lastValueFrom(
      client.emit(pattern, event).pipe(
        map(() => true),
        catchError(() => of(false)),
      ),
    );
  }

  private getPattern(event: VideoAcceptedDto | ProcessingCompletedDto): string {
    return 'zipStorageKey' in event ? 'ProcessingCompleted' : 'VideoAccepted';
  }
}
