import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Who a workspace belongs to. A validation job has no attempt yet, so its
 * directory is labelled `validation` instead.
 */
export interface WorkspaceOwner {
  processingRequestId: string;
  attemptId?: string;
}

/** Keeps an identifier from turning into a path separator or `..`. */
const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Owns a per-job directory under the system temp directory and guarantees
 * its removal. The directory is handed to the callback rather than acquired
 * by it, so no exit path, including a thrown timeout, can skip the release.
 */
@Injectable()
export class TempWorkspace {
  private readonly logger = new Logger(TempWorkspace.name);

  async withWorkspace<T>(
    owner: WorkspaceOwner,
    work: (dir: string) => Promise<T>,
  ): Promise<T> {
    // SPEC_DEVIATION: design.md declares `withWorkspace(jobId: string, ...)`.
    // Reason: the task requires the directory to be named by both
    // processingRequestId and attemptId, so the owner is passed as a pair and
    // the naming lives here rather than at every call site.
    const prefix = `fiapx-${safe(owner.processingRequestId)}-${safe(owner.attemptId ?? 'validation')}-`;
    // mkdtemp appends a random suffix, so two concurrent deliveries of the
    // same job never share (and never delete) each other's directory.
    const dir = await fs.mkdtemp(join(tmpdir(), prefix));
    try {
      return await work(dir);
    } finally {
      await this.remove(dir);
    }
  }

  private async remove(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      // The job's outcome is already decided; a leaked directory is an
      // operator concern, so it is reported and never rethrown.
      this.logger.error(
        `Could not remove temporary directory ${dir}: ${(error as Error).message}`,
      );
    }
  }
}
