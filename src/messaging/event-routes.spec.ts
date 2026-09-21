import {
  EVENT_ROUTES,
  WORKER_EVENT_TYPES,
  type WorkerEventType,
} from './event-routes';

describe('EVENT_ROUTES', () => {
  it('covers every event type the Worker can report', () => {
    expect(WORKER_EVENT_TYPES.sort()).toEqual(
      [
        'ProcessingCompleted',
        'ProcessingFailed',
        'ProcessingStarted',
        'VideoAccepted',
        'VideoRejected',
      ].sort(),
    );
  });

  it('gives every event type its own client token', () => {
    const clients = WORKER_EVENT_TYPES.map((t) => EVENT_ROUTES[t].client);

    expect(new Set(clients).size).toBe(WORKER_EVENT_TYPES.length);
  });

  it('gives every event type its own pattern', () => {
    const patterns = WORKER_EVENT_TYPES.map((t) => EVENT_ROUTES[t].pattern);

    expect(new Set(patterns).size).toBe(WORKER_EVENT_TYPES.length);
  });

  it('names the pattern after the event type, so the Catalog matches on it', () => {
    for (const type of WORKER_EVENT_TYPES) {
      expect(EVENT_ROUTES[type].pattern).toBe(type);
    }
  });

  it('routes the two events that share a payload shape to different clients', () => {
    // VideoAccepted, VideoRejected and ProcessingStarted all lack
    // zipStorageKey. Structural discrimination collapsed them into one
    // destination; these must stay distinct.
    const shapeSharing: WorkerEventType[] = [
      'VideoAccepted',
      'VideoRejected',
      'ProcessingStarted',
    ];
    const clients = shapeSharing.map((t) => EVENT_ROUTES[t].client);

    expect(new Set(clients).size).toBe(shapeSharing.length);
  });
});
