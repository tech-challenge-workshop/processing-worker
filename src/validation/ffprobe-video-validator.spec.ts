import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';
import { ChildProcessRunner } from '../media/child-process.runner';
import { FfprobeProbe, ProbeResult } from '../media/ffprobe-probe';
import { TempWorkspace, WorkspaceOwner } from '../media/temp-workspace';
import { InMemoryObjectStorage } from '../storage/in-memory-object-storage';
import { ObjectHead } from '../storage/object-storage.interface';
import {
  DEFAULT_VALIDATION_LIMITS,
  FfprobeVideoValidator,
  validationLimitsFromEnv,
} from './ffprobe-video-validator';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const SAMPLE = join(FIXTURES, 'sample-8s.mp4');
const MB_500 = 524288000;
const MP4_FAMILY = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'];

/** In-memory storage that records transfers and can misreport or fail. */
class RecordingStorage extends InMemoryObjectStorage {
  downloads: string[] = [];
  headOverride?: ObjectHead;
  failHead?: Error;
  failDownload?: Error;

  head(key: string): Promise<ObjectHead | undefined> {
    if (this.failHead) return Promise.reject(this.failHead);
    if (this.headOverride) return Promise.resolve(this.headOverride);
    return super.head(key);
  }

  download(key: string, destinationPath: string): Promise<void> {
    this.downloads.push(key);
    if (this.failDownload) return Promise.reject(this.failDownload);
    return super.download(key, destinationPath);
  }
}

/** Answers with a fixed probe result and records what it was asked about. */
class StubProbe extends FfprobeProbe {
  probed: { path: string; bytes: Buffer }[] = [];
  constructor(private readonly result: ProbeResult) {
    super(new ChildProcessRunner(), { binary: 'ffprobe', timeoutMs: 1 });
  }
  probe(path: string): Promise<ProbeResult> {
    this.probed.push({ path, bytes: readFileSync(path) });
    return Promise.resolve(this.result);
  }
}

/** The real workspace, remembering every directory it handed out. */
class RecordingWorkspace extends TempWorkspace {
  dirs: string[] = [];
  withWorkspace<T>(
    owner: WorkspaceOwner,
    work: (dir: string) => Promise<T>,
  ): Promise<T> {
    return super.withWorkspace(owner, (dir) => {
      this.dirs.push(dir);
      return work(dir);
    });
  }
}

const readableVideo = (
  overrides: Partial<Extract<ProbeResult, { readable: true }>> = {},
): ProbeResult => ({
  readable: true,
  formatNames: MP4_FAMILY,
  durationSeconds: 8,
  hasVideoStream: true,
  ...overrides,
});

describe('FfprobeVideoValidator', () => {
  const job: VideoValidationRequestedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'sources/video.mp4',
    occurredAt: '2026-09-25T00:00:00Z',
  };
  let storage: RecordingStorage;
  let workspace: RecordingWorkspace;
  let scratch: string;

  const validatorWith = (probe: FfprobeProbe): FfprobeVideoValidator =>
    new FfprobeVideoValidator(
      storage,
      probe,
      workspace,
      DEFAULT_VALIDATION_LIMITS,
    );

  const seed = async (bytes: Buffer | string): Promise<void> => {
    const path = join(scratch, 'seed');
    writeFileSync(path, bytes);
    await storage.upload(job.sourceStorageKey, path, 'video/mp4');
  };

  beforeEach(async () => {
    storage = new RecordingStorage();
    workspace = new RecordingWorkspace();
    scratch = mkdtempSync(join(tmpdir(), 'fiapx-validator-spec-'));
    await seed(readFileSync(SAMPLE));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  // RM-07 AC1
  it('accepts an MP4/MOV-family file with a video stream, at most 600 s and at most 500 MB, probing the downloaded bytes', async () => {
    const probe = new StubProbe(readableVideo());

    const outcome = await validatorWith(probe).validate(job);

    expect(outcome).toEqual({ accepted: true });
    expect(storage.downloads).toEqual([job.sourceStorageKey]);
    expect(probe.probed).toHaveLength(1);
    expect(probe.probed[0].bytes.equals(readFileSync(SAMPLE))).toBe(true);
    expect(probe.probed[0].path.startsWith(workspace.dirs[0])).toBe(true);
  });

  it('accepts the real 8-second MP4 through the real ffprobe', async () => {
    const probe = new FfprobeProbe(new ChildProcessRunner(), {
      binary: 'ffprobe',
      timeoutMs: 10000,
    });

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: true,
    });
  });

  it('accepts a duration of exactly 600 s and a size of exactly 500 MB', async () => {
    storage.headOverride = { sizeBytes: MB_500 };
    const probe = new StubProbe(readableVideo({ durationSeconds: 600 }));

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: true,
    });
  });

  // RM-07 AC2
  it('rejects a duration above 600 s with DURACAO_EXCEDIDA', async () => {
    const probe = new StubProbe(readableVideo({ durationSeconds: 600.5 }));

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'DURACAO_EXCEDIDA',
    });
  });

  // RM-07 AC3 + AC6
  it('rejects an object above 500 MB with FORMATO_INVALIDO from its reported size, without downloading or probing it', async () => {
    storage.headOverride = { sizeBytes: MB_500 + 1 };
    const probe = new StubProbe(readableVideo());

    const outcome = await validatorWith(probe).validate(job);

    expect(outcome).toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
    expect(storage.downloads).toEqual([]);
    expect(probe.probed).toEqual([]);
    expect(workspace.dirs).toEqual([]);
  });

  // RM-07 AC4
  it.each<[string, ProbeResult]>([
    [
      'a container outside the MP4/MOV family',
      readableVideo({ formatNames: ['matroska', 'webm'] }),
    ],
    ['no video stream', readableVideo({ hasVideoStream: false })],
    ['a file ffprobe cannot read', { readable: false }],
  ])('rejects %s with FORMATO_INVALIDO', async (_case, result) => {
    const probe = new StubProbe(result);

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
  });

  // MSG-13: RM-07 AC2 and AC4 both apply to a long video in an unsupported
  // container; the duration verdict wins, as the more informative rejection.
  it('rejects an mkv longer than 600 s with DURACAO_EXCEDIDA, not FORMATO_INVALIDO', async () => {
    const probe = new StubProbe(
      readableVideo({
        formatNames: ['matroska', 'webm'],
        durationSeconds: 601,
      }),
    );

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'DURACAO_EXCEDIDA',
    });
  });

  it('rejects an mkv within 600 s with FORMATO_INVALIDO', async () => {
    const probe = new StubProbe(
      readableVideo({ formatNames: ['matroska', 'webm'], durationSeconds: 8 }),
    );

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
  });

  it('rejects a text file renamed to .mp4 with FORMATO_INVALIDO through the real ffprobe', async () => {
    await seed('this is a text file renamed to .mp4\n');
    const probe = new FfprobeProbe(new ChildProcessRunner(), {
      binary: 'ffprobe',
      timeoutMs: 10000,
    });

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
  });

  it('rejects with FORMATO_INVALIDO when the probe times out', async () => {
    const hanging = join(scratch, 'hanging-ffprobe');
    writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(hanging, 0o755);
    const probe = new FfprobeProbe(new ChildProcessRunner(), {
      binary: hanging,
      timeoutMs: 200,
    });

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
    expect(existsSync(workspace.dirs[0])).toBe(false);
  });

  it('rejects with FORMATO_INVALIDO when ffprobe reports no duration', async () => {
    const probe = new StubProbe(readableVideo({ durationSeconds: undefined }));

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
  });

  // RM-07 AC5
  it('rejects an absent source object with FORMATO_INVALIDO and does not probe it', async () => {
    const probe = new StubProbe(readableVideo());

    const outcome = await validatorWith(probe).validate({
      ...job,
      sourceStorageKey: 'sources/missing.mp4',
    });

    expect(outcome).toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
    expect(storage.downloads).toEqual([]);
    expect(probe.probed).toEqual([]);
  });

  // Edge case: zero-length object
  it('rejects a zero-length object with FORMATO_INVALIDO', async () => {
    await seed('');
    const probe = new StubProbe(readableVideo());

    await expect(validatorWith(probe).validate(job)).resolves.toEqual({
      accepted: false,
      failureCode: 'FORMATO_INVALIDO',
    });
    expect(probe.probed).toEqual([]);
  });

  // Edge case: storage unreachable during validation
  it('propagates a storage failure on head instead of rejecting the file', async () => {
    const outage = new Error('connect ECONNREFUSED minio:9000');
    storage.failHead = outage;

    await expect(
      validatorWith(new StubProbe(readableVideo())).validate(job),
    ).rejects.toBe(outage);
  });

  it('propagates a storage failure on download and removes the workspace', async () => {
    const outage = new Error('socket hang up');
    storage.failDownload = outage;
    const probe = new StubProbe(readableVideo());

    await expect(validatorWith(probe).validate(job)).rejects.toBe(outage);
    expect(probe.probed).toEqual([]);
    expect(workspace.dirs).toHaveLength(1);
    expect(existsSync(workspace.dirs[0])).toBe(false);
  });

  it('removes the workspace after an accepted and after a rejected file', async () => {
    await validatorWith(new StubProbe(readableVideo())).validate(job);
    await validatorWith(new StubProbe({ readable: false })).validate(job);

    expect(workspace.dirs).toHaveLength(2);
    expect(workspace.dirs.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it('reads the limits from MAX_SOURCE_BYTES and MAX_DURATION_SECONDS, defaulting to 500 MB and 600 s', () => {
    expect(validationLimitsFromEnv({})).toEqual({
      maxSourceBytes: 524288000,
      maxDurationSeconds: 600,
    });
    expect(
      validationLimitsFromEnv({
        MAX_SOURCE_BYTES: '1000',
        MAX_DURATION_SECONDS: '30',
      }),
    ).toEqual({ maxSourceBytes: 1000, maxDurationSeconds: 30 });
  });
});
