import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  // Buffer until the pino logger is resolved, so bootstrap lines are JSON
  // too.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
  app.flushLogs();
}
void bootstrap();
