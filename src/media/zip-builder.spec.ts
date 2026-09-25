import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipEntries } from '../../test/support/zip-entries';
import { ZipBuilder } from './zip-builder';

// Real archiver, real files; the archive is read back by an independent
// central-directory parser rather than by the library that wrote it.
describe('ZipBuilder', () => {
  const builder = new ZipBuilder();
  let dir: string;
  let frames: string;

  const writeFrames = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => {
      const path = join(frames, `frame-${String(i + 1).padStart(5, '0')}.jpg`);
      writeFileSync(path, Buffer.from(`jpeg bytes of frame ${i + 1}`));
      return path;
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fiapx-zip-spec-'));
    frames = join(dir, 'frames');
    mkdirSync(frames);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores every file without compression, named by its file name, with its bytes intact', async () => {
    const files = writeFrames(3);
    const destination = join(dir, 'frames.zip');

    await builder.build(files, destination);

    const entries = zipEntries(readFileSync(destination));
    expect(entries.map((e) => e.name).sort()).toEqual([
      'frame-00001.jpg',
      'frame-00002.jpg',
      'frame-00003.jpg',
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
      expect(entry.data).toEqual(readFileSync(join(frames, entry.name)));
    }
  });

  it('resolves with the number of entries actually written', async () => {
    const files = writeFrames(4);
    const destination = join(dir, 'frames.zip');

    const count = await builder.build(files, destination);

    expect(count).toBe(4);
    expect(zipEntries(readFileSync(destination))).toHaveLength(4);
  });

  it('keeps temporal order when the entries are listed in lexical order', async () => {
    const files = writeFrames(12);
    const destination = join(dir, 'frames.zip');

    await builder.build(files, destination);

    const names = zipEntries(readFileSync(destination)).map((e) => e.name);
    expect([...names].sort()).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `frame-${String(i + 1).padStart(5, '0')}.jpg`,
      ),
    );
  });

  it('rejects an empty file list and writes no archive', async () => {
    const destination = join(dir, 'frames.zip');

    await expect(builder.build([], destination)).rejects.toThrow('no entries');
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects and leaves no archive when an input file cannot be read', async () => {
    const files = [...writeFrames(2), join(frames, 'frame-00003.jpg')];
    const destination = join(dir, 'frames.zip');

    await expect(builder.build(files, destination)).rejects.toThrow(/ENOENT/);
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects and leaves no archive when the destination cannot be written', async () => {
    const files = writeFrames(2);
    const destination = join(dir, 'missing-dir', 'frames.zip');

    await expect(builder.build(files, destination)).rejects.toThrow(/ENOENT/);
    expect(existsSync(destination)).toBe(false);
  });
});
