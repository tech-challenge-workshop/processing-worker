import type { Options as PinoHttpOptions } from 'pino-http';
import { CorrelationContext } from './correlation-context';

const ACCESS_LOG_EXCLUDED_PATHS = ['/health', '/health/live', '/metrics'];

// SPEC_DEVIATION: design.md lists only `*.`-prefixed paths. The redactor's
// wildcards need a parent key, so a root-level `{ sourceStorageKey }` would
// survive, and a logged event envelope (`{ event: { data: { zipStorageKey } } }`)
// nests the field two levels deep. The bare keys and the two-level wildcard
// are added so OBS-36's outcome (no storage key or presigned URL in a log
// line) holds for every shape the Worker logs.
// Reason: the spec-defined outcome outranks the design's literal path list.
// `*.url` also removes `req.url` from access-log lines; the Worker's HTTP
// surface is health and metrics only, so that loses nothing an operator uses.
const REDACTED_KEYS = [
  'sourceStorageKey',
  'zipStorageKey',
  'url',
  'email',
  'ownerEmail',
];
const REDACT_PATHS = [
  'req.headers.authorization',
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  ...REDACTED_KEYS.map((key) => `*.*.${key}`),
];

// `service` lives in the root mixin, not pino-http `customProps`: customProps
// reaches only request-scoped loggers, and OBS-35 requires it on every line
// (bootstrap and the two RMQ consumers included).
const SERVICE_NAME = 'processing-worker';

export interface RootLoggerConfig {
  pinoHttp: PinoHttpOptions;
}

export function buildRootLoggerConfig(
  context: CorrelationContext,
): RootLoggerConfig {
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? 'info',
      timestamp: () => `,"timestamp":${Date.now()}`,
      mixin: () => {
        const correlationId = context.getCorrelationId();
        return correlationId === undefined
          ? { service: SERVICE_NAME }
          : { service: SERVICE_NAME, correlationId };
      },
      redact: { paths: REDACT_PATHS, remove: true },
      autoLogging: {
        ignore: (req) => {
          const url = req.url;
          return url !== undefined && ACCESS_LOG_EXCLUDED_PATHS.includes(url);
        },
      },
    },
  };
}
