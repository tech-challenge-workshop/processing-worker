import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3ObjectStorage, S3Sender } from './s3-object-storage';

type Send = (command: unknown) => Promise<unknown>;
const sender = (send: Send): S3Sender => ({ send });

const notFound = (): S3ServiceException =>
  new S3ServiceException({
    name: 'NotFound',
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
    message: 'Not Found',
  });

describe('S3ObjectStorage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fiapx-s3-spec-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds a path-style client from the configured endpoint, bucket and credentials', async () => {
    const storage = S3ObjectStorage.fromConfig({
      endpoint: 'http://storage.internal:9000',
      bucket: 'fiapx',
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
    });
    const client = (storage as unknown as { client: S3Client }).client;
    const bucket = (storage as unknown as { bucket: string }).bucket;

    expect(client).toBeInstanceOf(S3Client);
    expect(client.config.forcePathStyle).toBe(true);
    const endpoint = await client.config.endpoint!();
    expect(`${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`).toBe(
      'http://storage.internal:9000',
    );
    await expect(client.config.credentials()).resolves.toMatchObject({
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
    });
    expect(bucket).toBe('fiapx');
  });

  it('reports size and content type from HeadObject on the configured bucket', async () => {
    const sent: unknown[] = [];
    const storage = new S3ObjectStorage(
      sender((command) => {
        sent.push(command);
        return Promise.resolve({
          ContentLength: 2048,
          ContentType: 'video/mp4',
        });
      }),
      'fiapx',
    );

    await expect(storage.head('sources/a.mp4')).resolves.toEqual({
      sizeBytes: 2048,
      contentType: 'video/mp4',
    });
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand);
    expect((sent[0] as HeadObjectCommand).input).toEqual({
      Bucket: 'fiapx',
      Key: 'sources/a.mp4',
    });
  });

  it('turns a NotFound / 404 from head into undefined instead of an error', async () => {
    const storage = new S3ObjectStorage(
      sender(() => Promise.reject(notFound())),
      'fiapx',
    );

    await expect(storage.head('sources/missing.mp4')).resolves.toBeUndefined();
  });

  it('rethrows a head failure that is not absence, such as an unreachable endpoint', async () => {
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const storage = new S3ObjectStorage(
      sender(() => Promise.reject(unreachable)),
      'fiapx',
    );

    await expect(storage.head('sources/a.mp4')).rejects.toBe(unreachable);
  });

  it('streams a download to disk as it arrives, without waiting for the whole body', async () => {
    // The body yields one chunk, then holds the rest until the test has seen
    // that chunk on disk. An adapter that buffered the whole object before
    // writing would never write it, and this test would time out.
    const destination = join(dir, 'source.mp4');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const chunk = Buffer.alloc(64 * 1024, 1);
    const body = Readable.from(
      (async function* () {
        yield chunk;
        await released;
        yield chunk;
      })(),
    );
    const sent: unknown[] = [];
    const storage = new S3ObjectStorage(
      sender((command) => {
        sent.push(command);
        return Promise.resolve({ Body: body });
      }),
      'fiapx',
    );

    const downloading = storage.download('sources/a.mp4', destination);
    const deadline = Date.now() + 2000;
    while (
      (!existsSync(destination) || statSync(destination).size < chunk.length) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const writtenBeforeEnd = existsSync(destination)
      ? statSync(destination).size
      : 0;
    release();
    await downloading;

    expect(writtenBeforeEnd).toBe(chunk.length);

    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
    expect((sent[0] as GetObjectCommand).input).toEqual({
      Bucket: 'fiapx',
      Key: 'sources/a.mp4',
    });
    expect(readFileSync(destination)).toEqual(Buffer.concat([chunk, chunk]));
  }, 5000);
});
