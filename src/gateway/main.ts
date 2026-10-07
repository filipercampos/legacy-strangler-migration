import { shutdownTracing, startTracing } from '../shared/observability/tracing';
startTracing('strangler-gateway');

import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { GatewayModule } from './gateway.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(GatewayModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3400));
  (app.getHttpServer() as Server).keepAliveTimeout = 65_000;
  process.once('SIGTERM', () => void shutdownTracing());
}

void bootstrap();
