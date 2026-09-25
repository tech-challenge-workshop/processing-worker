export interface ObjectHead {
  sizeBytes: number;
  contentType?: string;
}

/**
 * Reads and writes objects by key without naming a provider (AD-005).
 *
 * Transfers are declared in terms of local paths, so an adapter owns every
 * detail of how bytes move. Absence is a return value, not an exception: a
 * missing source is a rejection and a missing archive is the normal first
 * attempt, and neither belongs in a catch block.
 */
export interface ObjectStorage {
  /**
   * Which adapter this is, reported by readiness so a stack running on the
   * in-memory adapter is visible rather than silently inert.
   */
  readonly adapterName: string;
  /** `undefined` when no object exists at the key; never throws for absence. */
  head(key: string): Promise<ObjectHead | undefined>;
  /** Writes the object at `key` to `destinationPath`. */
  download(key: string, destinationPath: string): Promise<void>;
  /** Stores the file at `sourcePath` under `key`, replacing any object there. */
  upload(key: string, sourcePath: string, contentType: string): Promise<void>;
}

export const OBJECT_STORAGE = 'OBJECT_STORAGE';
