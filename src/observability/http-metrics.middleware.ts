import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { workerMetrics } from './metrics';

/**
 * Counts every served request with its route template (requests no route
 * matched report 'unmatched', keeping cardinality bounded), never the raw
 * path. Health and metrics are counted too; they are only kept out of the
 * access log. Counting runs on response finish and can never throw into the
 * pipeline. Same pattern as the API's and the Catalog's.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    res.on('finish', () => {
      try {
        const routePath = (req as { route?: { path: unknown } }).route?.path;
        // SPEC_DEVIATION: the API's and the Catalog's copy take any
        // `req.route.path`. Reason: nestjs-pino binds its HTTP logger as an
        // express `all('{/*splat}')` route, so a request no controller matched
        // arrives with that catch-all as its route; a wildcard is never one of
        // the Worker's route templates, so it reports 'unmatched' instead.
        const route =
          typeof routePath === 'string' && !routePath.includes('*')
            ? routePath
            : 'unmatched';
        workerMetrics.recordHttpRequest(
          req.method,
          route,
          String(res.statusCode),
        );
      } catch {
        // Metrics are a side effect: a counting failure must never fail a request.
      }
    });
    next();
  }
}
