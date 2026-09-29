import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { workerMetrics } from './metrics';

/**
 * Prometheus scrape endpoint (OBS-37). Unauthenticated by convention (the
 * Worker has no guard) and kept out of the access log (logger.config.ts).
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    // Raw setHeader + end: express's res.send would append '; charset=utf-8'
    // to the value, and the exposition contract pins it exactly.
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(await workerMetrics.metrics());
  }
}
