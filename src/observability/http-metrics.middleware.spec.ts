import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { workerMetrics } from './metrics';
import { ObservabilityModule } from './observability.module';

@Controller('items')
class ItemsController {
  @Get(':id')
  get(): { ok: boolean } {
    return { ok: true };
  }
}

// The real module, so the test covers the middleware's wiring as well as its
// behaviour.
@Module({ imports: [ObservabilityModule], controllers: [ItemsController] })
class TestAppModule {}

describe('HttpMetricsMiddleware', () => {
  let app: INestApplication<App>;
  let savedLogLevel: string | undefined;

  beforeAll(async () => {
    savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'silent';
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
  });

  beforeEach(() => {
    workerMetrics.resetMetrics();
  });

  it('records the route template for a matched request, never the raw path', async () => {
    const response = await request(app.getHttpServer()).get('/items/42');

    expect(response.status).toBe(200);
    const exposition = await workerMetrics.metrics();
    expect(exposition).toContain(
      'fiapx_http_requests_total{method="GET",route="/items/:id",status="200"} 1',
    );
    expect(exposition).not.toContain('route="/items/42"');
  });

  it("records 'unmatched' when no route template matched", async () => {
    const response = await request(app.getHttpServer()).get('/nope');

    expect(response.status).toBe(404);
    const exposition = await workerMetrics.metrics();
    expect(exposition).toContain(
      'fiapx_http_requests_total{method="GET",route="unmatched",status="404"} 1',
    );
    expect(exposition).not.toContain('route="/nope"');
  });

  it('counts each request exactly once', async () => {
    await request(app.getHttpServer()).get('/items/1');
    await request(app.getHttpServer()).get('/items/2');
    await request(app.getHttpServer()).get('/items/1');

    const exposition = await workerMetrics.metrics();
    expect(exposition).toContain(
      'fiapx_http_requests_total{method="GET",route="/items/:id",status="200"} 3',
    );
  });

  it('counts the metrics scrape itself, which is only kept out of the access log', async () => {
    await request(app.getHttpServer()).get('/metrics');

    expect(await workerMetrics.metrics()).toContain(
      'fiapx_http_requests_total{method="GET",route="/metrics",status="200"} 1',
    );
  });

  it('never throws into the pipeline when counting fails', async () => {
    const record = jest
      .spyOn(workerMetrics, 'recordHttpRequest')
      .mockImplementation(() => {
        throw new Error('registry down');
      });

    const response = await request(app.getHttpServer()).get('/items/42');

    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);

    record.mockRestore();
  });
});
