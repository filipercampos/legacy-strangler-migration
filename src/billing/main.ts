import { shutdownTracing, startTracing } from '../shared/observability/tracing';
startTracing('billing-service');

import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { BillingModule } from './billing.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(BillingModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3402));
  // Keep-alive above the ALB idle timeout (60 s) to avoid 502s on reused connections.
  (app.getHttpServer() as Server).keepAliveTimeout = 65_000;
  process.once('SIGTERM', () => void shutdownTracing());
}

void bootstrap();
