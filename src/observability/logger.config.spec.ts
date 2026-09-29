import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pinoHttp from 'pino-http';
import { CorrelationContext } from './correlation-context';
import { buildRootLoggerConfig } from './logger.config';

function createCapturingLogger(context: CorrelationContext) {
  const raw: string[] = [];
  const sink = new Writable({
    write(chunk: unknown, _encoding, callback) {
      raw.push(String(chunk));
      callback();
    },
  });
  const config = buildRootLoggerConfig(context);
  const instance = pinoHttp(config.pinoHttp, sink);
  return {
    instance,
    raw,
    parsed: (): Record<string, unknown>[] =>
      raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function withServer(
  logger: ReturnType<typeof createCapturingLogger>,
  handler: (server: Server) => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const server = createServer((req, res) =>
    logger.instance(req, res, () => {
      res.end('ok');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await handler(server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return logger.parsed();
}

describe('buildRootLoggerConfig', () => {
  let context: CorrelationContext;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    context = new CorrelationContext();
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('emits one json line per log with timestamp, level, msg, service and the als correlationId', () => {
    const logger = createCapturingLogger(context);

    context.runWithCorrelation('w-7', () => {
      logger.instance.logger.info('job consumed');
    });

    expect(logger.raw).toHaveLength(1);
    const [line] = logger.parsed();
    expect(typeof line['timestamp']).toBe('number');
    expect(line['level']).toBe(30);
    expect(line['msg']).toBe('job consumed');
    expect(line['service']).toBe('processing-worker');
    expect(line['correlationId']).toBe('w-7');
  });

  it('omits the correlationId key when no correlation scope is active', () => {
    const logger = createCapturingLogger(context);

    logger.instance.logger.info('bootstrap');

    const [line] = logger.parsed();
    expect(line['service']).toBe('processing-worker');
    expect(line).not.toHaveProperty('correlationId');
  });

  it('redacts the source and zip storage keys at the root, nested and inside an event envelope', () => {
    const logger = createCapturingLogger(context);

    logger.instance.logger.info({
      sourceStorageKey: 'root-src-key',
      zipStorageKey: 'root-zip-key',
      job: { sourceStorageKey: 'job-src-key', processingRequestId: 'pr-1' },
      event: { data: { zipStorageKey: 'event-zip-key', eventId: 'e-1' } },
      visible: 'kept',
    });

    const [line] = logger.parsed();
    expect(line).not.toHaveProperty('sourceStorageKey');
    expect(line).not.toHaveProperty('zipStorageKey');
    expect(line['job']).toEqual({ processingRequestId: 'pr-1' });
    expect(line['event']).toEqual({ data: { eventId: 'e-1' } });
    expect(line['visible']).toBe('kept');
    const output = logger.raw.join('');
    for (const key of [
      'root-src-key',
      'root-zip-key',
      'job-src-key',
      'event-zip-key',
    ]) {
      expect(output).not.toContain(key);
    }
  });

  it('redacts urls, emails and the authorization header wherever they appear', () => {
    const logger = createCapturingLogger(context);

    logger.instance.logger.info({
      url: 'https://storage/presigned?sig=root',
      ownerEmail: 'root@example.com',
      email: 'alice@example.com',
      download: { url: 'https://storage/presigned?sig=nested', id: 'd-1' },
      owner: { ownerEmail: 'one@example.com', userId: 'u-1' },
      err: { config: { url: 'amqp://user:pass@rabbitmq:5672', port: 5672 } },
      req: {
        headers: { authorization: 'Bearer token-123', 'user-agent': 'jest' },
      },
    });

    const [line] = logger.parsed();
    expect(line).not.toHaveProperty('url');
    expect(line).not.toHaveProperty('ownerEmail');
    expect(line).not.toHaveProperty('email');
    expect(line['download']).toEqual({ id: 'd-1' });
    expect(line['owner']).toEqual({ userId: 'u-1' });
    expect(line['err']).toEqual({ config: { port: 5672 } });
    expect(line['req']).toEqual({ headers: { 'user-agent': 'jest' } });
    const output = logger.raw.join('');
    for (const secret of [
      'sig=root',
      'sig=nested',
      'root@example.com',
      'alice@example.com',
      'one@example.com',
      'user:pass',
      'token-123',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('skips the access log for health, liveness and metrics only', async () => {
    const logger = createCapturingLogger(context);

    const lines = await withServer(logger, async (server) => {
      const { port } = server.address() as AddressInfo;
      for (const path of ['/health', '/health/live', '/metrics', '/']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { 'x-probe-path': path },
        });
        expect(response.status).toBe(200);
      }
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]['msg']).toBe('request completed');
    expect(lines[0]['service']).toBe('processing-worker');
    const req = lines[0]['req'] as { headers: Record<string, string> };
    expect(req.headers['x-probe-path']).toBe('/');
  });

  it('defaults to the info level when LOG_LEVEL is unset', () => {
    const logger = createCapturingLogger(context);

    logger.instance.logger.debug('hidden debug');
    logger.instance.logger.info('shown info');

    expect(logger.parsed().map((line) => line['msg'])).toEqual(['shown info']);
  });

  it('honors LOG_LEVEL from the environment', () => {
    process.env.LOG_LEVEL = 'error';
    const logger = createCapturingLogger(context);

    logger.instance.logger.info('hidden info');
    logger.instance.logger.error('shown error');

    expect(logger.parsed().map((line) => line['msg'])).toEqual(['shown error']);
  });
});
