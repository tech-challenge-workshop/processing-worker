import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryObjectStorage } from './in-memory-object-storage';

describe('InMemoryObjectStorage', () => {
  let dir: string;
  let storage: InMemoryObjectStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fiapx-storage-spec-'));
    storage = new InMemoryObjectStorage();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (name: string, content: string | Buffer): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('returns undefined from head for an absent key instead of throwing', async () => {
    await expect(storage.head('sources/missing.mp4')).resolves.toBeUndefined();
  });

  it('reports the size and content type of an uploaded object', async () => {
    await storage.upload(
      'zips/req/attempt/frames.zip',
      file('frames.zip', Buffer.alloc(1234, 7)),
      'application/zip',
    );

    await expect(storage.head('zips/req/attempt/frames.zip')).resolves.toEqual({
      sizeBytes: 1234,
      contentType: 'application/zip',
    });
  });

  it('round-trips the bytes of an upload through a download to a local path', async () => {
    const content = Buffer.from([0, 1, 2, 250, 251, 252]);
    await storage.upload('sources/a.mp4', file('a.mp4', content), 'video/mp4');
    const destination = join(dir, 'downloaded.mp4');

    await storage.download('sources/a.mp4', destination);

    expect(readFileSync(destination)).toEqual(content);
  });

  it('rejects a download of an absent key and writes nothing', async () => {
    const destination = join(dir, 'never.mp4');

    await expect(
      storage.download('sources/missing.mp4', destination),
    ).rejects.toThrow('No object at key sources/missing.mp4');
    expect(() => readFileSync(destination)).toThrow();
  });

  it('keeps one object per key when the same key is uploaded twice', async () => {
    await storage.upload('zips/k', file('one', 'first'), 'application/zip');
    await storage.upload('zips/k', file('two', 'second!'), 'application/zip');

    expect(storage.keys()).toEqual(['zips/k']);
    await expect(storage.head('zips/k')).resolves.toEqual({
      sizeBytes: 7,
      contentType: 'application/zip',
    });
  });
});
