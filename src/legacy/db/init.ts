/**
 * Creates and seeds the legacy database (local development only).
 * Usage: npm run legacy:init
 */
import { legacyAppEnvSchema, loadEnv } from '../../shared/config/env';
import { connectLegacyDb, legacyDbOptionsFromEnv } from './connection';
import { runLegacyScripts } from './scripts';

async function main(): Promise<void> {
  const env = loadEnv(legacyAppEnvSchema);
  const options = legacyDbOptionsFromEnv(env);
  const master = await connectLegacyDb({ ...options, database: 'master' });
  try {
    await runLegacyScripts(
      master,
      () => connectLegacyDb(options),
      { DB_NAME: options.database, SEED_CUSTOMERS: process.env.SEED_CUSTOMERS ?? '3000' },
      { includeSeed: true },
    );
  } finally {
    await master.close();
  }
  process.stdout.write(`legacy database ${options.database} ready\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
