import { register } from 'prom-client';
import { WorkerMetrics } from './metrics';

describe('WorkerMetrics', () => {
  let metrics: WorkerMetrics;

  beforeEach(() => {
    metrics = new WorkerMetrics();
  });

  it('exposes every family with its bounded label values before any job (OBS-37)', async () => {
    const exposition = await metrics.metrics();

    for (const series of [
      'fiapx_validation_total{outcome="accepted"} 0',
      'fiapx_validation_total{outcome="rejected"} 0',
      'fiapx_processing_total{outcome="completed"} 0',
      'fiapx_processing_total{outcome="failed"} 0',
      'fiapx_processing_duration_seconds_count 0',
      'fiapx_jobs_inflight{queue="validation"} 0',
      'fiapx_jobs_inflight{queue="processing"} 0',
    ]) {
      expect(exposition).toContain(series);
    }
    expect(exposition).toContain(
      '# TYPE fiapx_processing_duration_seconds histogram',
    );
  });

  it('counts a rejection under "rejected" only (OBS-38)', async () => {
    metrics.recordValidation('rejected');
    metrics.recordValidation('accepted');
    metrics.recordValidation('rejected');

    const exposition = await metrics.metrics();
    expect(exposition).toContain(
      'fiapx_validation_total{outcome="rejected"} 2',
    );
    expect(exposition).toContain(
      'fiapx_validation_total{outcome="accepted"} 1',
    );
  });

  it('counts each processing outcome and observes its duration once (OBS-39)', async () => {
    metrics.recordProcessing('completed', 2.5);
    metrics.recordProcessing('failed', 0.25);

    const exposition = await metrics.metrics();
    expect(exposition).toContain(
      'fiapx_processing_total{outcome="completed"} 1',
    );
    expect(exposition).toContain('fiapx_processing_total{outcome="failed"} 1');
    expect(exposition).toContain('fiapx_processing_duration_seconds_count 2');
    expect(exposition).toContain('fiapx_processing_duration_seconds_sum 2.75');
    expect(exposition).toContain(
      'fiapx_processing_duration_seconds_bucket{le="0.5"} 1',
    );
  });

  it('holds the queue gauge up while a job runs and releases it when it settles (OBS-40)', async () => {
    let during = '';

    const result = await metrics.inflight('processing').track(async () => {
      during = await metrics.metrics();
      return 'settled';
    });

    expect(result).toBe('settled');
    expect(during).toContain('fiapx_jobs_inflight{queue="processing"} 1');
    expect(during).toContain('fiapx_jobs_inflight{queue="validation"} 0');
    expect(await metrics.metrics()).toContain(
      'fiapx_jobs_inflight{queue="processing"} 0',
    );
  });

  it('releases the gauge when the job throws, and rethrows (L-009)', async () => {
    let during = '';

    await expect(
      metrics.inflight('validation').track(async () => {
        during = await metrics.metrics();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(during).toContain('fiapx_jobs_inflight{queue="validation"} 1');
    expect(await metrics.metrics()).toContain(
      'fiapx_jobs_inflight{queue="validation"} 0',
    );
  });

  it('counts concurrent jobs on one queue and returns to zero once all settle', async () => {
    const releases: Array<() => void> = [];
    const job = () =>
      metrics.inflight('processing').track(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );

    const running = [job(), job()];
    expect(await metrics.metrics()).toContain(
      'fiapx_jobs_inflight{queue="processing"} 2',
    );

    releases.forEach((release) => release());
    await Promise.all(running);
    expect(await metrics.metrics()).toContain(
      'fiapx_jobs_inflight{queue="processing"} 0',
    );
  });

  it('counts http requests by method, route and status', async () => {
    metrics.recordHttpRequest('GET', '/metrics', '200');

    expect(await metrics.metrics()).toContain(
      'fiapx_http_requests_total{method="GET",route="/metrics",status="200"} 1',
    );
  });

  it('keeps every family on its own registry and resets back to the zero series', async () => {
    metrics.recordValidation('accepted');
    metrics.recordProcessing('completed', 3);
    metrics.recordHttpRequest('GET', '/health', '200');

    expect(await register.metrics()).not.toContain('fiapx_');
    expect(() => new WorkerMetrics()).not.toThrow();

    metrics.resetMetrics();
    const exposition = await metrics.metrics();
    expect(exposition).toContain(
      'fiapx_validation_total{outcome="accepted"} 0',
    );
    expect(exposition).toContain(
      'fiapx_processing_total{outcome="completed"} 0',
    );
    expect(exposition).toContain('fiapx_processing_duration_seconds_count 0');
    expect(exposition).toContain('fiapx_jobs_inflight{queue="processing"} 0');
    expect(exposition).not.toContain('route="/health"');
  });
});
