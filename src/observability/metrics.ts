import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type ValidationOutcome = 'accepted' | 'rejected';
export type ProcessingOutcome = 'completed' | 'failed';
export type JobQueue = 'validation' | 'processing';

const VALIDATION_OUTCOMES: readonly ValidationOutcome[] = [
  'accepted',
  'rejected',
];
const PROCESSING_OUTCOMES: readonly ProcessingOutcome[] = [
  'completed',
  'failed',
];
const JOB_QUEUES: readonly JobQueue[] = ['validation', 'processing'];

// A job runs from a sub-second rejection to minutes of FFmpeg work on a long
// video; the buckets span that range so the dashboard percentiles mean
// something at both ends.
const PROCESSING_DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

/**
 * The Worker's Prometheus metrics on a dedicated registry, never the
 * prom-client global, so per-app state holds and e2e suites stay isolated.
 * Call sites use the one process-wide instance; unit tests build their own.
 *
 * Labels are bounded (`outcome`, `queue`, HTTP method/route/status): no
 * request ids, storage keys or paths. Every outcome and queue series exists
 * at zero from the start, so a dashboard rate() has a series before the
 * first job.
 */
export class WorkerMetrics {
  private readonly registry = new Registry();

  private readonly validationTotal = new Counter({
    name: 'fiapx_validation_total',
    help: 'Validation jobs by outcome.',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  private readonly processingTotal = new Counter({
    name: 'fiapx_processing_total',
    help: 'Processing jobs by outcome.',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: 'fiapx_processing_duration_seconds',
    help: 'Processing job duration in seconds, from handler start until it settles.',
    buckets: PROCESSING_DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly jobsInflight = new Gauge({
    name: 'fiapx_jobs_inflight',
    help: 'Jobs being handled right now, by queue.',
    labelNames: ['queue'],
    registers: [this.registry],
  });

  private readonly httpRequestsTotal = new Counter({
    name: 'fiapx_http_requests_total',
    help: 'HTTP requests served, by method, route template, and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });

  constructor() {
    this.initSeries();
  }

  recordValidation(outcome: ValidationOutcome): void {
    this.validationTotal.inc({ outcome });
  }

  recordProcessing(outcome: ProcessingOutcome, durationSeconds: number): void {
    this.processingTotal.inc({ outcome });
    this.processingDuration.observe(durationSeconds);
  }

  /**
   * Counts `fn` as in flight on `queue` while it runs: +1 before it starts,
   * -1 in a `finally`, so a throw releases the gauge as surely as a return.
   */
  inflight(queue: JobQueue): { track<T>(fn: () => Promise<T>): Promise<T> } {
    const gauge = this.jobsInflight;
    return {
      async track<T>(fn: () => Promise<T>): Promise<T> {
        gauge.inc({ queue });
        try {
          return await fn();
        } finally {
          gauge.dec({ queue });
        }
      },
    };
  }

  recordHttpRequest(method: string, route: string, status: string): void {
    this.httpRequestsTotal.inc({ method, route, status });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  resetMetrics(): void {
    this.registry.resetMetrics();
    this.initSeries();
  }

  private initSeries(): void {
    for (const outcome of VALIDATION_OUTCOMES) {
      this.validationTotal.inc({ outcome }, 0);
    }
    for (const outcome of PROCESSING_OUTCOMES) {
      this.processingTotal.inc({ outcome }, 0);
    }
    for (const queue of JOB_QUEUES) {
      this.jobsInflight.set({ queue }, 0);
    }
    // A registry reset drops even the label-free histogram's series.
    this.processingDuration.zero({});
  }
}

export const workerMetrics = new WorkerMetrics();
