import { shutdownTracing, startTracing } from '../shared/observability/tracing';
startTracing('legacy-billing');

import { legacyAppEnvSchema, loadEnv } from '../shared/config/env';
import { createLegacyApp } from './app';
import { connectLegacyDb, legacyDbOptionsFromEnv } from './db/connection';

async function main(): Promise<void> {
  const env = loadEnv(legacyAppEnvSchema);
  const pool = await connectLegacyDb({ ...legacyDbOptionsFromEnv(env), appName: 'legacy-billing' });
  const server = createLegacyApp(pool, env.LOG_LEVEL).listen(env.PORT);
  server.keepAliveTimeout = 65_000;

  process.once('SIGTERM', () => {
    server.close(() => {
      void pool.close().then(shutdownTracing);
    });
  });
}

void main();
