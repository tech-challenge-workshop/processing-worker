import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  MEDIA_BINARIES,
  MediaBinaries,
} from './../src/health/ffmpeg-availability.indicator';
import { RabbitmqHealthService } from './../src/messaging/rabbitmq-health.service';

// Every variable createObjectStorage (src/storage/storage.module.ts) reads.
// Any of them exported in the shell would switch this suite off the
// in-memory adapter its readiness bodies expect.
const STORAGE_VARS = [
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const;
type StorageEnv = Record<(typeof STORAGE_VARS)[number], string | undefined>;
const readStorageEnv = (): StorageEnv =>
  Object.fromEntries(
    STORAGE_VARS.map((v) => [v, process.env[v]]),
  ) as StorageEnv;
const writeStorageEnv = (values: StorageEnv): void => {
  for (const v of STORAGE_VARS) {
    if (values[v] === undefined) delete process.env[v];
    else process.env[v] = values[v];
  }
};

// Stands in for a shell that exports storage settings - an unreachable
// endpoint and junk credentials - so the readiness suite runs against them
// in every run, and the last suite checks they were handed back untouched.
const dirtyShell: StorageEnv = {
  STORAGE_ENDPOINT: 'http://127.0.0.1:9',
  STORAGE_BUCKET: 'junk-bucket',
  STORAGE_ACCESS_KEY: 'junk-access',
  STORAGE_SECRET_KEY: 'junk-secret',
};
let realShell: StorageEnv;

beforeAll(() => {
  realShell = readStorageEnv();
  writeStorageEnv(dirtyShell);
});

afterAll(() => {
  writeStorageEnv(realShell);
});

// The binaries are stand-in executables that answer `-version` like the real
// ones and record every invocation, so "absent" and "present" are real
// process outcomes rather than a mocked runner, and the invocation count is
// observable.
describe('Media readiness (e2e)', () => {
  let saved: StorageEnv;
  let dir: string;
  let app: INestApplication<App> | undefined;

  // Same save/clear/restore as test/composition.e2e-spec.ts: the suite runs
  // with no storage settings whatever the shell exports.
  beforeAll(() => {
    saved = readStorageEnv();
    for (const v of STORAGE_VARS) delete process.env[v];
  });

  afterAll(() => {
    writeStorageEnv(saved);
  });

  const stub = (name: string): string => {
    const path = join(dir, name);
    writeFileSync(
      path,
      `#!/bin/sh\necho "$0 $*" >> "${join(dir, 'calls.log')}"\necho "${name} version stub"\n`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const absent = (name: string): string => join(dir, 'missing', name);
  const calls = (): string[] => {
    try {
      return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };

  const start = async (
    binaries: MediaBinaries,
    rabbitmqConnected = true,
  ): Promise<INestApplication<App>> => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MEDIA_BINARIES)
      .useValue(binaries)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    app.get(RabbitmqHealthService).setConnected(rabbitmqConnected);
    return app;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fiapx-media-health-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is ready and reports both binaries when ffmpeg and ffprobe answer', async () => {
    const running = await start({
      ffmpeg: stub('ffmpeg'),
      ffprobe: stub('ffprobe'),
    });

    const response = await request(running.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      rabbitmq: true,
      media: { ffmpeg: true, ffprobe: true },
      storage: 'in-memory',
    });
  });

  it('is not ready, and names ffprobe, when ffprobe is absent', async () => {
    const running = await start({
      ffmpeg: stub('ffmpeg'),
      ffprobe: absent('ffprobe'),
    });

    const response = await request(running.getHttpServer()).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      rabbitmq: true,
      media: { ffmpeg: true, ffprobe: false },
      storage: 'in-memory',
    });
  });

  it('is not ready, and names ffmpeg, when ffmpeg is absent', async () => {
    const running = await start({
      ffmpeg: absent('ffmpeg'),
      ffprobe: stub('ffprobe'),
    });

    const response = await request(running.getHttpServer()).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      rabbitmq: true,
      media: { ffmpeg: false, ffprobe: true },
      storage: 'in-memory',
    });
  });

  it('probes each binary once at bootstrap, not per health request', async () => {
    const running = await start({
      ffmpeg: stub('ffmpeg'),
      ffprobe: stub('ffprobe'),
    });
    expect(calls()).toHaveLength(2);

    for (let i = 0; i < 3; i++) {
      await request(running.getHttpServer()).get('/health').expect(200);
    }

    const invocations = calls();
    expect(invocations).toHaveLength(2);
    expect(invocations.some((c) => c.endsWith('ffmpeg -version'))).toBe(true);
    expect(invocations.some((c) => c.endsWith('ffprobe -version'))).toBe(true);
  });

  it('keeps liveness up when the binaries are absent', async () => {
    const running = await start(
      { ffmpeg: absent('ffmpeg'), ffprobe: absent('ffprobe') },
      false,
    );

    await request(running.getHttpServer()).get('/health').expect(503);
    const live = await request(running.getHttpServer()).get('/health/live');

    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
  });
});

describe('Media readiness shell isolation (e2e)', () => {
  it('restores the storage variables it cleared once the readiness suite ends', () => {
    expect(readStorageEnv()).toEqual(dirtyShell);
  });
});
