import { Injectable } from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';
import { ObjectHead, ObjectStorage } from './object-storage.interface';

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

/**
 * Keeps objects in process memory. The adapter unit and e2e tests drive, and
 * the one the root selects when no storage credentials are configured.
 * `implements ObjectStorage` makes the compiler demand every member.
 */
@Injectable()
export class InMemoryObjectStorage implements ObjectStorage {
  readonly adapterName = 'in-memory';
  private readonly objects = new Map<string, StoredObject>();

  head(key: string): Promise<ObjectHead | undefined> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? { sizeBytes: object.bytes.length, contentType: object.contentType }
        : undefined,
    );
  }

  async download(key: string, destinationPath: string): Promise<void> {
    const object = this.objects.get(key);
    if (!object) {
      // The key stays out of the message: it is logged when the consumer
      // rethrows it, and a log line never carries a storage key (OBS-36).
      throw new Error('The requested key has no object');
    }
    await writeFile(destinationPath, object.bytes);
  }

  async upload(
    key: string,
    sourcePath: string,
    contentType: string,
  ): Promise<void> {
    const bytes = await readFile(sourcePath);
    this.objects.set(key, { bytes, contentType });
  }

  /** The stored keys, for tests that assert how many objects exist. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
