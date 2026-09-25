import { Logger, Module } from '@nestjs/common';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage.interface';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * Selects the object storage adapter from configuration: the S3 adapter when
 * both credentials are set, the in-memory one otherwise. The choice is logged
 * and reported by readiness, and asserted by test/composition.e2e-spec.ts,
 * because a silently selected in-memory adapter is how the Catalog once ran
 * with a persistence layer nothing referenced.
 */
export function createObjectStorage(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorage {
  const accessKeyId = env.STORAGE_ACCESS_KEY;
  const secretAccessKey = env.STORAGE_SECRET_KEY;
  const storage =
    accessKeyId && secretAccessKey
      ? S3ObjectStorage.fromConfig({
          endpoint: env.STORAGE_ENDPOINT ?? 'http://minio:9000',
          bucket: env.STORAGE_BUCKET ?? 'fiapx',
          accessKeyId,
          secretAccessKey,
        })
      : new InMemoryObjectStorage();
  new Logger('StorageModule').log(
    `Object storage adapter: ${storage.adapterName}`,
  );
  return storage;
}

@Module({
  providers: [
    { provide: OBJECT_STORAGE, useFactory: () => createObjectStorage() },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
