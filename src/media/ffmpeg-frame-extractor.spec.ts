import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChildProcessError,
  ChildProcessRunner,
  RunOptions,
  RunResult,
} from './child-process.runner';
import {
  FfmpegFrameExtractor,
  ffmpegOptionsFromEnv,
} from './ffmpeg-frame-extractor';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** Records the invocation, then runs a side effect in place of FFmpeg. */
class ScriptedRunner extends ChildProcessRunner {
  calls: { command: string; args: string[]; options: RunOptions }[] = [];
  constructor(private readonly effect: (args: string[]) => Promise<void>) {
    super();
  }
  async run(
    command: string,
    args: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    this.calls.push({ command, args, options });
    await this.effect(args);
    return { stdout: '', stderr: '' };
  }
}

// The real ffmpeg for everything about real frames; a scripted runner only
// for the argument vector and for what is on disk when FFmpeg misbehaves.
// Nothing here skips without the binary.
describe('FfmpegFrameExtractor', () => {
  const real = new FfmpegFrameExtractor(new ChildProcessRunner(), {
    binary: 'ffmpeg',
    threads: 1,
    timeoutMs: 60000,
  });
  let out: string;

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'fiapx-extractor-spec-'));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it('invokes ffmpeg with -nostdin, fps=1, the configured -threads and the frame pattern', async () => {
    const runner = new ScriptedRunner(() => Promise.resolve());
    const extractor = new FfmpegFrameExtractor(runner, {
      binary: 'ffmpeg',
      threads: 3,
      timeoutMs: 4321,
    });

    await extractor.extract('/work/source', out);

    expect(runner.calls).toEqual([
      {
        command: 'ffmpeg',
        args: [
          '-nostdin',
          '-v',
          'error',
          '-i',
          '/work/source',
          '-vf',
          'fps=1',
          '-threads',
          '3',
          join(out, 'frame-%05d.jpg'),
        ],
        options: { timeoutMs: 4321 },
      },
    ]);
  });

  it('takes the thread count from FFMPEG_THREADS and defaults to 1, never to host detection', () => {
    expect(ffmpegOptionsFromEnv({ FFMPEG_THREADS: '2' }).threads).toBe(2);
    expect(ffmpegOptionsFromEnv({}).threads).toBe(1);
    expect(ffmpegOptionsFromEnv({ FFMPEG_THREADS: '0' }).threads).toBe(1);
    expect(ffmpegOptionsFromEnv({ FFMPEG_THREADS: 'auto' }).threads).toBe(1);
    expect(ffmpegOptionsFromEnv({}).timeoutMs).toBe(600000);
    expect(ffmpegOptionsFromEnv({ FFMPEG_TIMEOUT_MS: '5000' }).timeoutMs).toBe(
      5000,
    );
  });

  it('writes one JPEG per second of a real 8-second MP4, returned in temporal order', async () => {
    const frames = await real.extract(join(FIXTURES, 'sample-8s.mp4'), out);

    expect(frames).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => join(out, `frame-0000${n}.jpg`)),
    );
    for (const frame of frames) {
      expect(readFileSync(frame).subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    }
  });

  it('still produces one frame for a video shorter than one second', async () => {
    const frames = await real.extract(join(FIXTURES, 'sample-0.5s.mp4'), out);

    expect(frames).toEqual([join(out, 'frame-00001.jpg')]);
  });

  it('returns exactly the frames ffmpeg emits for a duration that is not a whole number of seconds', async () => {
    const frames = await real.extract(join(FIXTURES, 'sample-2.5s.mp4'), out);

    const written = readdirSync(out).sort();
    expect(frames.map((f) => f.slice(out.length + 1))).toEqual(written);
    expect(frames).toHaveLength(3);
  });

  it('reads the list back from the directory, sorted, ignoring anything that is not a frame', async () => {
    const extractor = new FfmpegFrameExtractor(
      new ScriptedRunner(() => {
        for (const name of [
          'frame-00010.jpg',
          'frame-00002.jpg',
          'source',
          'frame-00001.jpg',
        ]) {
          writeFileSync(join(out, name), 'x');
        }
        return Promise.resolve();
      }),
      { binary: 'ffmpeg', threads: 1, timeoutMs: 1000 },
    );

    await expect(extractor.extract('/work/source', out)).resolves.toEqual([
      join(out, 'frame-00001.jpg'),
      join(out, 'frame-00002.jpg'),
      join(out, 'frame-00010.jpg'),
    ]);
  });

  it('rejects when ffmpeg exits non-zero on a file that is not a video', async () => {
    const notes = join(out, 'notes.mp4');
    writeFileSync(notes, 'this is a text file renamed to .mp4\n');

    const error = await real.extract(notes, out).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChildProcessError);
    expect((error as ChildProcessError).exitCode).not.toBe(0);
  });

  it('rejects, returning no frame list, when ffmpeg fails after writing some frames', async () => {
    const extractor = new FfmpegFrameExtractor(
      new ScriptedRunner(() => {
        writeFileSync(join(out, 'frame-00001.jpg'), 'x');
        return Promise.reject(new Error('ffmpeg exited with code 1'));
      }),
      { binary: 'ffmpeg', threads: 1, timeoutMs: 1000 },
    );

    await expect(extractor.extract('/work/source', out)).rejects.toThrow(
      'ffmpeg exited with code 1',
    );
  });

  it('rejects with the timeout named when ffmpeg outlives its limit', async () => {
    const hanging = join(out, 'hanging-ffmpeg');
    writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(hanging, 0o755);
    const extractor = new FfmpegFrameExtractor(new ChildProcessRunner(), {
      binary: hanging,
      threads: 1,
      timeoutMs: 200,
    });

    const error = await extractor
      .extract(join(FIXTURES, 'sample-8s.mp4'), out)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChildProcessError);
    expect((error as ChildProcessError).timedOut).toBe(true);
  });
});
