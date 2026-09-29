import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { RabbitmqHealthService } from '../messaging/rabbitmq-health.service';
import { OBJECT_STORAGE } from '../storage/object-storage.interface';
import { FfmpegAvailabilityIndicator } from './ffmpeg-availability.indicator';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let app: INestApplication<App>;

  afterEach(async () => {
    await app.close();
  });

  it('answers /health 503 while the broker is unreachable and /health/live 200 (OBS-41)', async () => {
    const broker = new RabbitmqHealthService();
    broker.setConnected(false);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: RabbitmqHealthService, useValue: broker },
        {
          provide: FfmpegAvailabilityIndicator,
          useValue: {
            isHealthy: () => Promise.resolve(true),
            capabilities: () => ({ ffmpeg: true, ffprobe: true }),
          },
        },
        { provide: OBJECT_STORAGE, useValue: { adapterName: 'in-memory' } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const readiness = await request(app.getHttpServer()).get('/health');
    const liveness = await request(app.getHttpServer()).get('/health/live');
    const legacy = await request(app.getHttpServer()).get('/live');

    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({ status: 'error', rabbitmq: false });
    expect(liveness.status).toBe(200);
    expect(liveness.body).toEqual({ status: 'ok' });
    expect(legacy.status).toBe(404);
  });
});
