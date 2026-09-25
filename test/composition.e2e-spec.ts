import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { InMemoryObjectStorage } from './../src/storage/in-memory-object-storage';
import {
  OBJECT_STORAGE,
  ObjectStorage,
} from './../src/storage/object-storage.interface';
import { S3ObjectStorage } from './../src/storage/s3-object-storage';

// Asserts what the composition root actually selects. The Catalog once
// shipped a complete persistence layer that app.module.ts never referenced,
// with 36 tests green and zero tables in the running stack; every test here
// builds the real AppModule and reads the provider it resolved, and the
// readiness body a running instance reports.
describe('Composition root: object storage selection (e2e)', () => {
  const STORAGE_VARS = [
    'STORAGE_ENDPOINT',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
  ] as const;
  let saved: Record<string, string | undefined>;
  let app: INestApplication<App> | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(STORAGE_VARS.map((v) => [v, process.env[v]]));
    for (const v of STORAGE_VARS) delete process.env[v];
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const v of STORAGE_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  const boot = async (): Promise<INestApplication<App>> => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    return app;
  };

  it('selects the S3 adapter, configured from the environment, when credentials are set', async () => {
    process.env.STORAGE_ENDPOINT = 'http://storage.internal:9000';
    process.env.STORAGE_BUCKET = 'composition-bucket';
    process.env.STORAGE_ACCESS_KEY = 'access';
    process.env.STORAGE_SECRET_KEY = 'secret';

    const running = await boot();
    const storage = running.get<ObjectStorage>(OBJECT_STORAGE);

    expect(storage).toBeInstanceOf(S3ObjectStorage);
    const internals = storage as unknown as {
      client: S3Client;
      bucket: string;
    };
    expect(internals.bucket).toBe('composition-bucket');
    const endpoint = await internals.client.config.endpoint!();
    expect(endpoint.hostname).toBe('storage.internal');
    expect(endpoint.port).toBe(9000);
    await expect(internals.client.config.credentials()).resolves.toMatchObject({
      accessKeyId: 'access',
      secretAccessKey: 'secret',
    });
  });

  it('selects the in-memory adapter when credentials are absent', async () => {
    process.env.STORAGE_ENDPOINT = 'http://storage.internal:9000';

    const running = await boot();

    expect(running.get<ObjectStorage>(OBJECT_STORAGE)).toBeInstanceOf(
      InMemoryObjectStorage,
    );
  });

  it('names the selected adapter in the readiness response', async () => {
    const inMemory = await boot();
    const withoutCredentials = await request(inMemory.getHttpServer()).get(
      '/health',
    );
    await inMemory.close();

    process.env.STORAGE_ACCESS_KEY = 'access';
    process.env.STORAGE_SECRET_KEY = 'secret';
    const s3 = await boot();
    const withCredentials = await request(s3.getHttpServer()).get('/health');

    expect(withoutCredentials.body).toMatchObject({ storage: 'in-memory' });
    expect(withCredentials.body).toMatchObject({ storage: 's3' });
  });
});
