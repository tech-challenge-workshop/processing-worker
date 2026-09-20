/**
 * Every outcome this Worker can report.
 *
 * The publisher resolves a destination from this union. It deliberately does
 * not infer the type from the payload: `VideoRejected` and `ProcessingStarted`
 * share a shape with `VideoAccepted`, so any structural discrimination would
 * misroute them and still report success.
 */
export type WorkerEventType =
  | 'VideoAccepted'
  | 'VideoRejected'
  | 'ProcessingStarted'
  | 'ProcessingCompleted'
  | 'ProcessingFailed';

export interface EventRoute {
  /** Injection token of the `ClientProxy` bound to this event's queue. */
  client: string;
  /** Pattern the Catalog consumer matches on. */
  pattern: string;
}

/**
 * Declared as a `Record` over the union, so a new event type without a route
 * fails the type check rather than falling through to a default destination.
 */
export const EVENT_ROUTES: Record<WorkerEventType, EventRoute> = {
  VideoAccepted: {
    client: 'RMQ_VIDEO_ACCEPTED_CLIENT',
    pattern: 'VideoAccepted',
  },
  VideoRejected: {
    client: 'RMQ_VIDEO_REJECTED_CLIENT',
    pattern: 'VideoRejected',
  },
  ProcessingStarted: {
    client: 'RMQ_PROCESSING_STARTED_CLIENT',
    pattern: 'ProcessingStarted',
  },
  ProcessingCompleted: {
    client: 'RMQ_PROCESSING_COMPLETED_CLIENT',
    pattern: 'ProcessingCompleted',
  },
  ProcessingFailed: {
    client: 'RMQ_PROCESSING_FAILED_CLIENT',
    pattern: 'ProcessingFailed',
  },
};

export const WORKER_EVENT_TYPES = Object.keys(
  EVENT_ROUTES,
) as WorkerEventType[];
