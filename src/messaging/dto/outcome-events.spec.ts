import { ProcessingCompletedDto } from './processing-completed.dto';
import { ProcessingFailedDto } from './processing-failed.dto';
import { ProcessingStartedDto } from './processing-started.dto';
import { VideoAcceptedDto } from './video-accepted.dto';
import { VideoRejectedDto } from './video-rejected.dto';

// The five outcome contracts carry the field as an optional string. The shape
// is proven at compile time by `npm run typecheck`, which covers this file:
// the literals below stop compiling if a DTO loses the field, if it becomes
// required, or if it accepts a non-string.
// SPEC_DEVIATION: tasks.md says "via the index export"; this repo has no DTO
// barrel and nothing would import one, so each contract is imported directly.
// Reason: adding an unused barrel only to test through it is dead code.
describe('outcome event contracts', () => {
  it('carry an optional string correlationId on all five outcome events', () => {
    const base = {
      eventId: 'e-1',
      processingRequestId: 'pr-1',
      occurredAt: '2026-09-28T00:00:00.000Z',
    };
    const withId = [
      { ...base, correlationId: 'w-7' } satisfies VideoAcceptedDto,
      {
        ...base,
        failureCode: 'FORMATO_INVALIDO',
        correlationId: 'w-7',
      } satisfies VideoRejectedDto,
      {
        ...base,
        attemptId: 'a-1',
        correlationId: 'w-7',
      } satisfies ProcessingStartedDto,
      {
        ...base,
        attemptId: 'a-1',
        zipStorageKey: 'zips/pr-1.zip',
        correlationId: 'w-7',
      } satisfies ProcessingCompletedDto,
      {
        ...base,
        attemptId: 'a-1',
        failureCode: 'PROCESSAMENTO_FALHOU',
        correlationId: 'w-7',
      } satisfies ProcessingFailedDto,
    ];
    const withoutId: [
      VideoAcceptedDto,
      VideoRejectedDto,
      ProcessingStartedDto,
      ProcessingCompletedDto,
      ProcessingFailedDto,
    ] = [
      base,
      { ...base, failureCode: 'FORMATO_INVALIDO' },
      { ...base, attemptId: 'a-1' },
      { ...base, attemptId: 'a-1', zipStorageKey: 'zips/pr-1.zip' },
      { ...base, attemptId: 'a-1', failureCode: 'PROCESSAMENTO_FALHOU' },
    ];
    const numeric: [
      VideoAcceptedDto,
      VideoRejectedDto,
      ProcessingStartedDto,
      ProcessingCompletedDto,
      ProcessingFailedDto,
    ] = [
      // @ts-expect-error correlationId is a string, never a number
      { ...base, correlationId: 7 },
      // @ts-expect-error correlationId is a string, never a number
      { ...base, failureCode: 'FORMATO_INVALIDO', correlationId: 7 },
      // @ts-expect-error correlationId is a string, never a number
      { ...base, attemptId: 'a-1', correlationId: 7 },
      {
        ...base,
        attemptId: 'a-1',
        zipStorageKey: 'zips/pr-1.zip',
        // @ts-expect-error correlationId is a string, never a number
        correlationId: 7,
      },
      {
        ...base,
        attemptId: 'a-1',
        failureCode: 'PROCESSAMENTO_FALHOU',
        // @ts-expect-error correlationId is a string, never a number
        correlationId: 7,
      },
    ];

    expect(withId.map((event) => event.correlationId)).toEqual(
      Array(5).fill('w-7'),
    );
    expect(withoutId.every((event) => !('correlationId' in event))).toBe(true);
    // Compile-time only: each numeric id above must fail to type-check.
    void numeric;
  });
});
