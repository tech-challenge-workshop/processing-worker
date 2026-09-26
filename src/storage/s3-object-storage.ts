import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ObjectHead, ObjectStorage } from './object-storage.interface';

export interface S3ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The SDK requires a region to sign requests. S3-compatible servers such as
 * RustFS accept any value, so it is fixed rather than configured.
 */
const SIGNING_REGION = 'us-east-1';

/** The only member of the SDK client this adapter uses. */
export type S3Sender = Pick<S3Client, 'send'>;

/**
 * The object storage port over the S3 API. RustFS locally (AD-014) and any managed
 * S3-compatible store are this same adapter with a different endpoint
 * (AD-005); no provider name appears above this file.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly adapterName = 's3';

  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  static fromConfig(config: S3ObjectStorageConfig): S3ObjectStorage {
    const client = new S3Client({
      endpoint: config.endpoint,
      region: SIGNING_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    return new S3ObjectStorage(client, config.bucket);
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType,
      };
    } catch (error) {
      // Only absence is a value. An unreachable endpoint or a denied request
      // must stay an error: validation requeues on it instead of blaming
      // the user's file.
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async download(key: string, destinationPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error(`Object ${key} has no readable body`);
    }
    // Streamed straight to disk: a 500 MB source is never held in memory.
    await pipeline(response.Body, createWriteStream(destinationPath));
  }

  async upload(
    key: string,
    sourcePath: string,
    contentType: string,
  ): Promise<void> {
    const { size } = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}
