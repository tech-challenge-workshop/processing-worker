import {
  outcomeEventId,
  OUTCOME_EVENT_ID_NAMESPACE,
  uuidV5,
} from './outcome-event-id';
import { WORKER_EVENT_TYPES } from './event-routes';

const UUID_V5_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the published v5 value for a known name and namespace', () => {
    // The DNS namespace from RFC 4122 appendix C, and the value every
    // conforming implementation (Python's uuid.uuid5, the uuid package)
    // produces for this name.
    expect(
      uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    ).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});

describe('outcomeEventId', () => {
  it('is a version 5 UUID', () => {
    for (const outcome of WORKER_EVENT_TYPES) {
      expect(outcomeEventId('evt-1', outcome)).toMatch(UUID_V5_REGEX);
    }
  });

  it('is the same for the same consumed id and outcome', () => {
    expect(outcomeEventId('evt-1', 'ProcessingCompleted')).toBe(
      outcomeEventId('evt-1', 'ProcessingCompleted'),
    );
    expect(outcomeEventId('evt-1', 'ProcessingCompleted')).toBe(
      uuidV5('evt-1:ProcessingCompleted', OUTCOME_EVENT_ID_NAMESPACE),
    );
  });

  it('differs for a different consumed id, so a new attempt gets new ids', () => {
    expect(outcomeEventId('evt-1', 'ProcessingCompleted')).not.toBe(
      outcomeEventId('evt-2', 'ProcessingCompleted'),
    );
  });

  it('differs for every outcome of the same consumed event', () => {
    const ids = WORKER_EVENT_TYPES.map((outcome) =>
      outcomeEventId('evt-1', outcome),
    );

    expect(new Set(ids).size).toBe(WORKER_EVENT_TYPES.length);
  });
});
