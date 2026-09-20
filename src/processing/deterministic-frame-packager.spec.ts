import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { DeterministicFramePackager } from './deterministic-frame-packager';

describe('DeterministicFramePackager', () => {
  const packager = new DeterministicFramePackager();
  const job: ProcessingQueuedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'videos/input.mp4',
    attemptId: 'attempt-1',
    occurredAt: '2026-09-20T00:00:00Z',
  };

  it('derives the key from the request and the attempt', async () => {
    await expect(packager.packageFrames(job)).resolves.toBe(
      'local/req-1/attempt-1/frames.zip',
    );
  });

  it('returns the same key for the same attempt, so a redelivery addresses one object', async () => {
    const first = await packager.packageFrames(job);
    const second = await packager.packageFrames(job);

    expect(second).toBe(first);
  });

  it('returns a different key for a different attempt', async () => {
    const other = await packager.packageFrames({
      ...job,
      attemptId: 'attempt-2',
    });

    expect(other).toBe('local/req-1/attempt-2/frames.zip');
  });
});
