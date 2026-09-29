import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { workerMetrics } from './metrics';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    workerMetrics.resetMetrics();
  });

  it('serves every worker family, unauthenticated, as Prometheus text 0.0.4 (OBS-37, OBS-42)', async () => {
    const response = await request(app.getHttpServer()).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4');
    for (const series of [
      'fiapx_validation_total{outcome="accepted"} 0',
      'fiapx_validation_total{outcome="rejected"} 0',
      'fiapx_processing_total{outcome="completed"} 0',
      'fiapx_processing_total{outcome="failed"} 0',
      'fiapx_processing_duration_seconds_count 0',
      'fiapx_jobs_inflight{queue="validation"} 0',
      'fiapx_jobs_inflight{queue="processing"} 0',
    ]) {
      expect(response.text).toContain(series);
    }
  });

  it('serves the process-wide registry the consumers record into', async () => {
    workerMetrics.recordValidation('rejected');
    workerMetrics.recordProcessing('completed', 1.5);

    const response = await request(app.getHttpServer()).get('/metrics');

    expect(response.text).toContain(
      'fiapx_validation_total{outcome="rejected"} 1',
    );
    expect(response.text).toContain(
      'fiapx_processing_total{outcome="completed"} 1',
    );
    expect(response.text).toContain(
      'fiapx_processing_duration_seconds_count 1',
    );
  });
});
