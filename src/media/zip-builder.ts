import { Injectable } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Packs files into one archive whose entries are stored, not compressed:
 * JPEG frames do not compress, so any zlib level above zero is CPU spent for
 * nothing.
 */
@Injectable()
export class ZipBuilder {
  /**
   * Writes `files` to `destinationPath`, each entry named by its file name,
   * and resolves with the number of entries actually written. Rejects on an
   * empty list, which would be indistinguishable from a stub's output, and
   * leaves nothing at the destination when the write fails.
   */
  async build(files: string[], destinationPath: string): Promise<number> {
    if (files.length === 0) {
      throw new Error('Refusing to build an archive with no entries');
    }

    const archive = new ZipArchive({ zlib: { level: 0 } });
    let written = 0;
    archive.on('entry', () => {
      written += 1;
    });
    // A file that cannot be read is a failure, not a skipped entry.
    const unreadable = new Promise<never>((_, reject) =>
      archive.on('warning', reject),
    );
    const output = pipeline(archive, createWriteStream(destinationPath));

    try {
      for (const file of files) {
        archive.file(file, { name: basename(file) });
      }
      await Promise.race([
        Promise.all([output, archive.finalize()]),
        unreadable,
      ]);
    } catch (error) {
      // Stop queued entries and let the output close before removing it, so
      // nothing keeps writing after this call has returned.
      archive.abort();
      await output.catch(() => undefined);
      await rm(destinationPath, { force: true });
      throw error;
    }
    return written;
  }
}
