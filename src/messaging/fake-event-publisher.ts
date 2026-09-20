import { Injectable } from '@nestjs/common';
import { EventPublisher, type WorkerEvent } from './event-publisher.interface';
import { type WorkerEventType } from './event-routes';

export interface PublishedRecord {
  type: WorkerEventType;
  event: WorkerEvent;
}

@Injectable()
export class FakeEventPublisher implements EventPublisher {
  private readonly records: PublishedRecord[] = [];
  private nextResult = true;

  publish(type: WorkerEventType, event: WorkerEvent): Promise<boolean> {
    this.records.push({ type, event });
    return Promise.resolve(this.nextResult);
  }

  setNextResult(result: boolean): void {
    this.nextResult = result;
  }

  /** The declared type of each published event, in order. */
  get publishedTypes(): readonly WorkerEventType[] {
    return this.records.map((r) => r.type);
  }

  /** Type and payload together, for assertions about routing. */
  get published(): readonly PublishedRecord[] {
    return this.records;
  }

  get publishedEvents(): readonly WorkerEvent[] {
    return this.records.map((r) => r.event);
  }

  clear(): void {
    this.records.length = 0;
    this.nextResult = true;
  }
}
