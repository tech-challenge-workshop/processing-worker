/**
 * Reads a ZIP's central directory without a library, so the tests that
 * inspect an archive do not trust the code that wrote it. Enough of the
 * format for archives this service produces: no ZIP64, no comment.
 */
export interface ZipEntry {
  name: string;
  /** 0 is STORE (no compression), 8 is DEFLATE. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The entry's bytes; only extracted for stored entries. */
  data?: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function zipEntries(zip: Buffer): ZipEntry[] {
  const eocd = zip.length - 22;
  if (eocd < 0 || zip.readUInt32LE(eocd) !== EOCD_SIGNATURE) {
    throw new Error('Not a ZIP archive: no end of central directory record');
  }
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Bad central directory entry at ${offset}`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    let data: Buffer | undefined;
    if (method === 0) {
      if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error(`Bad local header for ${name}`);
      }
      const start =
        localOffset +
        30 +
        zip.readUInt16LE(localOffset + 26) +
        zip.readUInt16LE(localOffset + 28);
      data = zip.subarray(start, start + compressedSize);
    }

    entries.push({ name, method, compressedSize, uncompressedSize, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
