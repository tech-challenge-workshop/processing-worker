import { ProcessingQueuedDto } from './processing-queued.dto';
import { VideoValidationRequestedDto } from './video-validation-requested.dto';

// The two consumed contracts carry the field as an optional string. The shape
// is proven at compile time by `npm run typecheck`, which covers this file:
// the literals below stop compiling if a DTO loses the field, if it becomes
// required, or if it accepts a non-string.
describe('consumed event contracts', () => {
  it('carry an optional string correlationId on both consumed events', () => {
    const base = {
      eventId: 'e-1',
      processingRequestId: 'pr-1',
      ownerUserId: 'u-1',
      sourceStorageKey: 'uploads/pr-1.mp4',
      occurredAt: '2026-09-28T00:00:00.000Z',
    };
    const withId = [
      { ...base, correlationId: 'w-7' } satisfies VideoValidationRequestedDto,
      {
        ...base,
        attemptId: 'a-1',
        correlationId: 'w-7',
      } satisfies ProcessingQueuedDto,
    ];
    const withoutId: [VideoValidationRequestedDto, ProcessingQueuedDto] = [
      base,
      { ...base, attemptId: 'a-1' },
    ];
    const numeric: [VideoValidationRequestedDto, ProcessingQueuedDto] = [
      // @ts-expect-error correlationId is a string, never a number
      { ...base, correlationId: 7 },
      // @ts-expect-error correlationId is a string, never a number
      { ...base, attemptId: 'a-1', correlationId: 7 },
    ];

    expect(withId.map((event) => event.correlationId)).toEqual(['w-7', 'w-7']);
    expect(withoutId.every((event) => !('correlationId' in event))).toBe(true);
    // Compile-time only: each numeric id above must fail to type-check.
    void numeric;
  });
});
