import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { AcceptAllVideoValidator } from './accept-all-video-validator';
import type { VideoValidator } from './video-validator.interface';

describe('AcceptAllVideoValidator', () => {
  const validator: VideoValidator = new AcceptAllVideoValidator();

  const job: VideoValidationRequestedDto = {
    eventId: 'event-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'videos/input.mp4',
    occurredAt: '2026-09-20T00:00:00Z',
  };

  it('accepts a job', async () => {
    await expect(validator.validate(job)).resolves.toEqual({ accepted: true });
  });

  it('accepts a job whose source key looks unacceptable, because it inspects nothing', async () => {
    const outcome = await validator.validate({
      ...job,
      sourceStorageKey: 'videos/not-a-video.txt',
    });

    expect(outcome.accepted).toBe(true);
  });
});
