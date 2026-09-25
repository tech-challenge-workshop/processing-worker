import { Logger } from '@nestjs/common';
import { existsSync, promises as fsPromises } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TempWorkspace } from './temp-workspace';

// Against the real filesystem: a stubbed fs would hide exactly the leak this
// class exists to prevent.
describe('TempWorkspace', () => {
  const workspace = new TempWorkspace();
  const owner = { processingRequestId: 'req-42', attemptId: 'attempt-7' };

  afterEach(() => jest.restoreAllMocks());

  it('creates a directory under the system temp directory named by processingRequestId and attemptId', async () => {
    let seen = '';
    await workspace.withWorkspace(owner, (dir) => {
      seen = dir;
      expect(existsSync(dir)).toBe(true);
      return Promise.resolve();
    });

    expect(dirname(seen)).toBe(tmpdir());
    expect(basename(seen)).toMatch(/^fiapx-req-42-attempt-7-/);
  });

  it('removes the directory and its contents after the callback returns, and returns its value', async () => {
    let seen = '';
    const result = await workspace.withWorkspace(owner, async (dir) => {
      seen = dir;
      await mkdir(join(dir, 'frames'));
      await writeFile(join(dir, 'frames', 'frame-00001.jpg'), 'jpeg');
      await writeFile(join(dir, 'source.mp4'), 'video');
      return 'frames.zip';
    });

    expect(result).toBe('frames.zip');
    expect(existsSync(seen)).toBe(false);
  });

  it('removes the directory when the callback throws, and propagates the original error unchanged', async () => {
    const original = new Error('ffmpeg timed out');
    let seen = '';

    const outcome = workspace.withWorkspace(owner, async (dir) => {
      seen = dir;
      await writeFile(join(dir, 'partial.jpg'), 'half');
      throw original;
    });

    await expect(outcome).rejects.toBe(original);
    expect(existsSync(seen)).toBe(false);
  });

  it('logs the path and keeps the callback outcome when removal fails', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(fsPromises, 'rm')
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    let seen = '';

    const result = await workspace.withWorkspace(owner, (dir) => {
      seen = dir;
      return Promise.resolve('frames.zip');
    });

    expect(result).toBe('frames.zip');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain(seen);
    jest.restoreAllMocks();
    await fsPromises.rm(seen, { recursive: true, force: true });
  });

  it('keeps the callback error, not the removal error, when both fail', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(fsPromises, 'rm')
      .mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    const original = new Error('upload failed');
    let seen = '';

    const outcome = workspace.withWorkspace(owner, (dir) => {
      seen = dir;
      return Promise.reject(original);
    });

    await expect(outcome).rejects.toBe(original);
    jest.restoreAllMocks();
    await fsPromises.rm(seen, { recursive: true, force: true });
  });

  it('names a validation workspace, which has no attempt, and cannot escape the temp directory', async () => {
    let seen = '';
    await workspace.withWorkspace(
      { processingRequestId: '../../etc/req' },
      (dir) => {
        seen = dir;
        return Promise.resolve();
      },
    );

    expect(dirname(seen)).toBe(tmpdir());
    expect(basename(seen)).toMatch(/^fiapx-______etc_req-validation-/);
  });
});
