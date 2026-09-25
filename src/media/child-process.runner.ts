import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * How long a process that ignored SIGTERM is given before SIGKILL. A hung
 * FFmpeg must not hold a job forever.
 */
export const KILL_GRACE_MS = 2000;

/**
 * A command that did not exit 0: it exited non-zero, was killed after its
 * timeout, or could not be started at all (`exitCode` and `signal` both
 * null, `cause` set).
 */
export class ChildProcessError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
    readonly timedOut: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChildProcessError';
  }
}

/**
 * Runs one external command to completion. Uses `spawn` with an argument
 * vector, never `exec`: no shell sits between the caller and the command, so
 * a storage key containing a quote is an argument, not syntax.
 */
@Injectable()
export class ChildProcessRunner {
  run(
    command: string,
    args: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      }, options.timeoutMs);

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        outcome();
      };

      child.on('error', (error) => {
        finish(() =>
          reject(
            new ChildProcessError(
              `${command} could not be started: ${error.message}`,
              command,
              null,
              null,
              Buffer.concat(stderr).toString('utf8'),
              false,
              { cause: error },
            ),
          ),
        );
      });

      child.on('close', (exitCode, signal) => {
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        finish(() => {
          if (timedOut) {
            reject(
              new ChildProcessError(
                `${command} timed out after ${options.timeoutMs} ms and was killed (${signal ?? 'no signal'})`,
                command,
                exitCode,
                signal,
                err,
                true,
              ),
            );
          } else if (exitCode === 0) {
            resolve({ stdout: out, stderr: err });
          } else {
            reject(
              new ChildProcessError(
                `${command} exited with code ${exitCode ?? 'null'}${signal ? ` (${signal})` : ''}: ${err.trim()}`,
                command,
                exitCode,
                signal,
                err,
                false,
              ),
            );
          }
        });
      });
    });
  }
}
