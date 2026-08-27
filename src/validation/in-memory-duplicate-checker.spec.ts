import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';

describe('InMemoryDuplicateChecker', () => {
  let checker: InMemoryDuplicateChecker;

  beforeEach(() => {
    checker = new InMemoryDuplicateChecker();
  });

  it('returns false for a new eventId', async () => {
    const result = await checker.isDuplicate('evt-1');
    expect(result).toBe(false);
  });

  it('returns true after the eventId has been marked', async () => {
    await checker.mark('evt-1');
    const result = await checker.isDuplicate('evt-1');
    expect(result).toBe(true);
  });

  it('returns false for a different eventId after marking another', async () => {
    await checker.mark('evt-1');
    const result = await checker.isDuplicate('evt-2');
    expect(result).toBe(false);
  });
});
