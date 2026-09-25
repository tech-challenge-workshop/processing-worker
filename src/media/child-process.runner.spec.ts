import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChildProcessError,
  ChildProcessRunner,
  KILL_GRACE_MS,
} from './child-process.runner';

// Real short-lived processes, never a mocked child_process: a spawn misuse
// (shell quoting, lost stderr, a timeout that never fires) only shows up
// against the real OS.
const NODE = process.execPath;

describe('ChildProcessRunner', () => {
  const runner = new ChildProcessRunner();

  it('resolves with stdout and stderr when the command exits 0', async () => {
    const result = await runner.run(
      NODE,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { timeoutMs: 5000 },
    );

    expect(result).toEqual({ stdout: 'out', stderr: 'err' });
  });

  it('passes each argument verbatim, with no shell in between', async () => {
    const hostile = `it's "quoted"; echo injected $(id) \`id\``;

    const result = await runner.run('printf', ['%s', hostile], {
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe(hostile);
  });

  it('does not use exec anywhere in its source', () => {
    const source = readFileSync(
      join(__dirname, 'child-process.runner.ts'),
      'utf8',
    );

    expect(source).toMatch(/\bspawn\(/);
    expect(source).not.toMatch(/\bexec(File)?(Sync)?\(/);
    expect(source).not.toMatch(/shell:\s*true/);
  });

  it('rejects with the exit code and the captured stderr on a non-zero exit', async () => {
    const error = await runner
      .run(NODE, ['-e', 'process.stderr.write("bad input"); process.exit(3)'], {
        timeoutMs: 5000,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChildProcessError);
    const failure = error as ChildProcessError;
    expect(failure.exitCode).toBe(3);
    expect(failure.stderr).toBe('bad input');
    expect(failure.timedOut).toBe(false);
    expect(failure.message).toContain('bad input');
  });

  it('rejects a plain non-zero exit such as `false`', async () => {
    const error = await runner
      .run('false', [], { timeoutMs: 5000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChildProcessError);
    expect((error as ChildProcessError).exitCode).toBe(1);
  });

  it('sends SIGTERM to a command that outlives its timeout and names the timeout', async () => {
    const started = Date.now();
    const error = await runner
      .run('sleep', ['5'], { timeoutMs: 200 })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(ChildProcessError);
    const failure = error as ChildProcessError;
    expect(failure.timedOut).toBe(true);
    expect(failure.signal).toBe('SIGTERM');
    expect(failure.message).toMatch(/timed out after 200 ms/);
    expect(elapsed).toBeLessThan(2000);
  });

  it('follows with SIGKILL when the command ignores SIGTERM', async () => {
    const script = [
      'process.on("SIGTERM", () => process.stderr.write("got SIGTERM"));',
      'process.stdout.write("ready");',
      'setInterval(() => {}, 1000);',
    ].join('');
    const started = Date.now();
    const error = await runner
      .run(NODE, ['-e', script], { timeoutMs: 300 })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(ChildProcessError);
    const failure = error as ChildProcessError;
    expect(failure.stderr).toContain('got SIGTERM');
    expect(failure.signal).toBe('SIGKILL');
    expect(failure.timedOut).toBe(true);
    expect(failure.message).toMatch(/timed out/);
    expect(elapsed).toBeGreaterThanOrEqual(300 + KILL_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(300 + KILL_GRACE_MS + 2000);
  }, 10000);

  it('rejects rather than hanging when the command does not exist', async () => {
    const error = await runner
      .run('/nonexistent/fiapx-binary', [], { timeoutMs: 5000 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChildProcessError);
    const failure = error as ChildProcessError;
    expect(failure.exitCode).toBeNull();
    expect(failure.timedOut).toBe(false);
    expect(failure.message).toMatch(/could not be started/);
  });
});
