import {
  CreateBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3ObjectStorage } from './../src/storage/s3-object-storage';

// Round-trips the adapter against a real S3 endpoint (RustFS from
// fiap-x-platform locally, a RustFS container in CI; AD-014). Skipped by its own guard
// when STORAGE_ENDPOINT is unset on a developer machine; in CI an unset
// endpoint fails instead, so the suite can never go green by skipping.
const endpoint = process.env.STORAGE_ENDPOINT;
const config = {
  endpoint: endpoint ?? '',
  bucket: process.env.STORAGE_BUCKET ?? 'fiapx',
  accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'fiapx-dev',
  secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'fiapx-dev-secret',
};

if (!endpoint && process.env.CI) {
  describe('S3ObjectStorage against a real endpoint', () => {
    it('requires STORAGE_ENDPOINT in CI', () => {
      throw new Error('STORAGE_ENDPOINT must be set in CI');
    });
  });
}

(endpoint ? describe : describe.skip)(
  'S3ObjectStorage against a real endpoint',
  () => {
    const key = `e2e/${randomUUID()}/frames.zip`;
    const raw = new S3Client({
      endpoint: config.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    let dir: string;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'fiapx-s3-e2e-'));
      try {
        await raw.send(new CreateBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (
          name !== 'BucketAlreadyOwnedByYou' &&
          name !== 'BucketAlreadyExists'
        ) {
          throw error;
        }
      }
    });

    afterAll(async () => {
      await raw.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      raw.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    const storage = S3ObjectStorage.fromConfig(config);

    it('returns undefined from head before the object exists', async () => {
      await expect(storage.head(key)).resolves.toBeUndefined();
    });

    it('uploads a file, reports its size and type, and downloads the same bytes', async () => {
      const content = Buffer.from(
        Array.from({ length: 70_000 }, (_, i) => i % 251),
      );
      const source = join(dir, 'upload.zip');
      writeFileSync(source, content);

      await storage.upload(key, source, 'application/zip');

      await expect(storage.head(key)).resolves.toEqual({
        sizeBytes: content.length,
        contentType: 'application/zip',
      });
      const destination = join(dir, 'download.zip');
      await storage.download(key, destination);
      expect(readFileSync(destination)).toEqual(content);
    });
  },
);
