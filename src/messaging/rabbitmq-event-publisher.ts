import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, map, of } from 'rxjs';
import { correlationContext } from '../observability/correlation-context';
import { EventPublisher, type WorkerEvent } from './event-publisher.interface';
import { EVENT_ROUTES, type WorkerEventType } from './event-routes';

@Injectable()
export class RabbitmqEventPublisher implements EventPublisher {
  constructor(private readonly moduleRef: ModuleRef) {}

  async publish(type: WorkerEventType, event: WorkerEvent): Promise<boolean> {
    const route = EVENT_ROUTES[type];

    if (!route) {
      // Reached only if a caller defeats the type system. Throwing keeps an
      // unroutable event from being delivered to whichever queue happens to
      // be first, which is the failure this design exists to remove.
      throw new Error(`No route configured for event type ${String(type)}`);
    }

    const client = this.moduleRef.get<ClientProxy>(route.client, {
      strict: false,
    });

    return lastValueFrom(
      client.emit(route.pattern, withContextCorrelationId(event)).pipe(
        map(() => true),
        catchError(() => of(false)),
      ),
    );
  }
}

/**
 * Every outcome carries the id of the message being handled (OBS-32/33). It
 * is read from the correlation context at emit time rather than passed in, so
 * no call site can forget it. Outside a scope the field is omitted, never
 * sent as null.
 */
function withContextCorrelationId(event: WorkerEvent): WorkerEvent {
  const correlationId = correlationContext.getCorrelationId();
  return correlationId === undefined ? event : { ...event, correlationId };
}
