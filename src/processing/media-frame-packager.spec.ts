import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipEntries } from '../../test/support/zip-entries';
import { ProcessingQueuedDto } from '../messaging/dto/processing-queued.dto';
import { ChildProcessRunner } from '../media/child-process.runner';
import { FfmpegFrameExtractor } from '../media/ffmpeg-frame-extractor';
import { TempWorkspace, WorkspaceOwner } from '../media/temp-workspace';
import { ZipBuilder } from '../media/zip-builder';
import { InMemoryObjectStorage } from '../storage/in-memory-object-storage';
import { ObjectHead } from '../storage/object-storage.interface';
import {
  DeterministicFramePackager,
  frameArchiveKey,
} from './deterministic-frame-packager';
import { MediaFramePackager } from './media-frame-packager';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** Every stage appends here, so the order of the pipeline is observable. */
type Log = string[];

class LoggingStorage extends InMemoryObjectStorage {
  failHead?: Error;
  failDownload?: Error;
  failUpload?: Error;
  uploadGate?: Promise<void>;
  constructor(private readonly log: Log) {
    super();
  }
  head(key: string): Promise<ObjectHead | undefined> {
    this.log.push(`head ${key}`);
    return this.failHead ? Promise.reject(this.failHead) : super.head(key);
  }
  download(key: string, destinationPath: string): Promise<void> {
    this.log.push(`download ${key}`);
    return this.failDownload
      ? Promise.reject(this.failDownload)
      : super.download(key, destinationPath);
  }
  async upload(key: string, sourcePath: string, type: string): Promise<void> {
    this.log.push(`upload ${key}`);
    if (this.failUpload) throw this.failUpload;
    await this.uploadGate;
    await super.upload(key, sourcePath, type);
  }
  seed(key: string, sourcePath: string): Promise<void> {
    return super.upload(key, sourcePath, 'video/mp4');
  }
}

class LoggingExtractor extends FfmpegFrameExtractor {
  fail?: (destinationDir: string) => Promise<never>;
  constructor(private readonly log: Log) {
    super(new ChildProcessRunner(), {
      binary: 'ffmpeg',
      threads: 1,
      timeoutMs: 60000,
    });
  }
  extract(sourcePath: string, destinationDir: string): Promise<string[]> {
    this.log.push('extract');
    return this.fail
      ? this.fail(destinationDir)
      : super.extract(sourcePath, destinationDir);
  }
}

class LoggingZip extends ZipBuilder {
  fail?: Error;
  reportedEntries?: number;
  constructor(private readonly log: Log) {
    super();
  }
  async build(files: string[], destinationPath: string): Promise<number> {
    this.log.push('zip');
    if (this.fail) throw this.fail;
    const written = await super.build(files, destinationPath);
    return this.reportedEntries ?? written;
  }
}

class RecordingWorkspace extends TempWorkspace {
  dirs: string[] = [];
  owners: WorkspaceOwner[] = [];
  withWorkspace<T>(
    owner: WorkspaceOwner,
    work: (dir: string) => Promise<T>,
  ): Promise<T> {
    this.owners.push(owner);
    return super.withWorkspace(owner, (dir) => {
      this.dirs.push(dir);
      return work(dir);
    });
  }
}

// Real ffmpeg, real archiver, real filesystem; each stage is wrapped only to
// log its turn and to inject a failure where a test needs one.
describe('MediaFramePackager', () => {
  const job: ProcessingQueuedDto = {
    eventId: 'evt-1',
    processingRequestId: 'req-1',
    ownerUserId: 'user-1',
    sourceStorageKey: 'sources/sample-8s.mp4',
    attemptId: 'attempt-1',
    occurredAt: '2026-09-25T00:00:00Z',
  };
  const KEY = 'zips/req-1/attempt-1/frames.zip';
  let log: Log;
  let storage: LoggingStorage;
  let extractor: LoggingExtractor;
  let zip: LoggingZip;
  let workspace: RecordingWorkspace;
  let packager: MediaFramePackager;

  beforeEach(async () => {
    log = [];
    storage = new LoggingStorage(log);
    extractor = new LoggingExtractor(log);
    zip = new LoggingZip(log);
    workspace = new RecordingWorkspace();
    packager = new MediaFramePackager(storage, extractor, zip, workspace);
    await storage.seed(job.sourceStorageKey, join(FIXTURES, 'sample-8s.mp4'));
  });

  const storedArchive = async (): Promise<Buffer> => {
    const scratch = mkdtempSync(join(tmpdir(), 'fiapx-packager-spec-'));
    try {
      await storage.download(KEY, join(scratch, 'frames.zip'));
      return readFileSync(join(scratch, 'frames.zip'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const expectCleanFailure = async (message: string): Promise<void> => {
    await expect(packager.packageFrames(job)).rejects.toThrow(message);
    expect(await storage.head(KEY)).toBeUndefined();
    expect(storage.keys()).toEqual([job.sourceStorageKey]);
    expect(workspace.dirs).toHaveLength(1);
    expect(existsSync(workspace.dirs[0])).toBe(false);
  };

  it('stores one archive of one JPEG per second at the deterministic key and returns that key', async () => {
    const key = await packager.packageFrames(job);

    expect(key).toBe(KEY);
    expect(storage.keys().sort()).toEqual([KEY, job.sourceStorageKey].sort());
    expect(await storage.head(KEY)).toMatchObject({
      contentType: 'application/zip',
    });
    const entries = zipEntries(await storedArchive());
    expect(entries.map((e) => e.name).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `frame-0000${n}.jpg`),
    );
    for (const entry of entries) {
      expect(entry.data?.subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    }
  });

  it('derives the same key as the deterministic packager', async () => {
    const key = await packager.packageFrames(job);

    expect(key).toBe(frameArchiveKey(job));
    await expect(
      new DeterministicFramePackager().packageFrames(job),
    ).resolves.toBe(key);
  });

  it('downloads, extracts, zips and uploads in that order, with the upload last', async () => {
    await packager.packageFrames(job);

    expect(log).toEqual([
      `head ${KEY}`,
      `download ${job.sourceStorageKey}`,
      'extract',
      'zip',
      `upload ${KEY}`,
    ]);
    expect(workspace.owners).toEqual([
      { processingRequestId: 'req-1', attemptId: 'attempt-1' },
    ]);
    expect(existsSync(workspace.dirs[0])).toBe(false);
  });

  it('returns the key of an archive already stored without downloading, extracting or storing again', async () => {
    await packager.packageFrames(job);
    const first = await storedArchive();
    log.length = 0;

    const key = await packager.packageFrames(job);

    expect(key).toBe(KEY);
    expect(log).toEqual([`head ${KEY}`]);
    expect(storage.keys().sort()).toEqual([KEY, job.sourceStorageKey].sort());
    expect((await storedArchive()).equals(first)).toBe(true);
  });

  it('resolves only after the upload has been confirmed', async () => {
    let confirm!: () => void;
    storage.uploadGate = new Promise((resolve) => (confirm = resolve));
    let settled = false;

    const packaging = packager.packageFrames(job).then((key) => {
      settled = true;
      return key;
    });
    while (!log.includes(`upload ${KEY}`)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    confirm();
    await expect(packaging).resolves.toBe(KEY);
    expect(await storage.head(KEY)).toBeDefined();
  });

  it('propagates a download failure, stores nothing and removes the workspace', async () => {
    storage.failDownload = new Error('storage unreachable on download');

    await expectCleanFailure('storage unreachable on download');
    expect(log).not.toContain('extract');
  });

  it('propagates an extraction failure after partial frames, stores nothing and removes the workspace', async () => {
    extractor.fail = async (dir) => {
      await writeFile(join(dir, 'frame-00001.jpg'), 'partial');
      throw new Error('ffmpeg exited with code 1');
    };

    await expectCleanFailure('ffmpeg exited with code 1');
    expect(log).not.toContain('zip');
  });

  it('propagates a zip failure, stores nothing and removes the workspace', async () => {
    zip.fail = new Error('ENOSPC: no space left on device');

    await expectCleanFailure('ENOSPC');
  });

  it('propagates an upload failure, stores nothing and removes the workspace', async () => {
    storage.failUpload = new Error('storage unreachable on upload');

    await expectCleanFailure('storage unreachable on upload');
  });

  it('refuses to upload an archive whose entry count differs from the extracted frames', async () => {
    zip.reportedEntries = 7;

    await expectCleanFailure('Archive holds 7 entries for 8 extracted frames');
    expect(log).not.toContain(`upload ${KEY}`);
  });

  it('propagates a storage failure on the initial head without extracting', async () => {
    storage.failHead = new Error('connect ECONNREFUSED minio:9000');

    await expect(packager.packageFrames(job)).rejects.toThrow('ECONNREFUSED');
    expect(log).toEqual([`head ${KEY}`]);
    expect(workspace.dirs).toEqual([]);
  });

  it('completes with one frame for a video shorter than one second', async () => {
    const short = { ...job, sourceStorageKey: 'sources/sample-0.5s.mp4' };
    await storage.seed(
      short.sourceStorageKey,
      join(FIXTURES, 'sample-0.5s.mp4'),
    );

    await expect(packager.packageFrames(short)).resolves.toBe(KEY);
    expect(zipEntries(await storedArchive()).map((e) => e.name)).toEqual([
      'frame-00001.jpg',
    ]);
  });
});
