import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChildProcessRunner,
  RunOptions,
  RunResult,
} from './child-process.runner';
import { FfprobeProbe, ffprobeOptionsFromEnv } from './ffprobe-probe';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** Records the invocation and answers with canned output. */
class CannedRunner extends ChildProcessRunner {
  calls: { command: string; args: string[]; options: RunOptions }[] = [];
  constructor(private readonly stdout: string) {
    super();
  }
  run(
    command: string,
    args: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    this.calls.push({ command, args, options });
    return Promise.resolve({ stdout: this.stdout, stderr: '' });
  }
}

// The real binary for everything FFprobe decides about a real file; a canned
// runner only where the output itself is the variable under test. No test
// here skips when ffprobe is absent: CI installs it and the image ships it.
describe('FfprobeProbe', () => {
  const realProbe = new FfprobeProbe(new ChildProcessRunner(), {
    binary: 'ffprobe',
    timeoutMs: 10000,
  });
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'fiapx-probe-spec-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('invokes ffprobe with the documented argument vector and the configured timeout', async () => {
    const runner = new CannedRunner('{"format":{},"streams":[]}');
    const probe = new FfprobeProbe(runner, {
      binary: 'ffprobe',
      timeoutMs: 1234,
    });

    await probe.probe('/work/source.mp4');

    expect(runner.calls).toEqual([
      {
        command: 'ffprobe',
        args: [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          '/work/source.mp4',
        ],
        options: { timeoutMs: 1234 },
      },
    ]);
  });

  it('reports the MP4/MOV container family, the duration and a video stream for a real MP4', async () => {
    const result = await realProbe.probe(join(FIXTURES, 'sample-8s.mp4'));

    expect(result).toEqual({
      readable: true,
      formatNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
      durationSeconds: 8,
      hasVideoStream: true,
    });
  });

  it('reports hasVideoStream false for an MP4-family container with no video stream', async () => {
    const result = await realProbe.probe(join(FIXTURES, 'audio-only.m4a'));

    expect(result).toMatchObject({
      readable: true,
      formatNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
      hasVideoStream: false,
    });
  });

  it('returns { readable: false } when ffprobe exits non-zero on a file that is not media', async () => {
    const path = join(scratch, 'notes.mp4');
    writeFileSync(path, 'this is a text file renamed to .mp4\n');

    await expect(realProbe.probe(path)).resolves.toEqual({ readable: false });
  });

  it('returns { readable: false } when ffprobe outlives its timeout', async () => {
    const hanging = join(scratch, 'hanging-ffprobe');
    writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(hanging, 0o755);
    const probe = new FfprobeProbe(new ChildProcessRunner(), {
      binary: hanging,
      timeoutMs: 200,
    });

    await expect(probe.probe(join(FIXTURES, 'sample-8s.mp4'))).resolves.toEqual(
      { readable: false },
    );
  });

  it('returns { readable: false } when ffprobe emits output that is not JSON', async () => {
    const probe = new FfprobeProbe(new CannedRunner('Input #0, garbage'), {
      binary: 'ffprobe',
      timeoutMs: 1000,
    });

    await expect(probe.probe('/work/source.mp4')).resolves.toEqual({
      readable: false,
    });
  });

  it('leaves the duration absent, not zero, when ffprobe reports none', async () => {
    const probe = new FfprobeProbe(
      new CannedRunner(
        JSON.stringify({
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
          streams: [{ codec_type: 'video' }],
        }),
      ),
      { binary: 'ffprobe', timeoutMs: 1000 },
    );

    const result = await probe.probe('/work/source.mp4');

    expect(result).toEqual({
      readable: true,
      formatNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
      hasVideoStream: true,
    });
    expect(result).not.toHaveProperty('durationSeconds');
  });

  it('takes the timeout from FFPROBE_TIMEOUT_MS and defaults to 30000 ms', () => {
    expect(ffprobeOptionsFromEnv({ FFPROBE_TIMEOUT_MS: '4500' })).toEqual({
      binary: 'ffprobe',
      timeoutMs: 4500,
    });
    expect(ffprobeOptionsFromEnv({}).timeoutMs).toBe(30000);
  });
});
