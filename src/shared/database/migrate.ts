/** Usage: npm run migrate (one-off ECS task in AWS, before the services roll). */
import { billingEnvSchema, loadEnv } from '../config/env';
import { createDatabase } from './database';
import { migrateToLatest } from './migrator';

async function main(): Promise<void> {
  const env = loadEnv(billingEnvSchema);
  const db = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: 1,
    applicationName: 'migrate',
  });
  try {
    const applied = await migrateToLatest(db);
    process.stdout.write(`applied: ${applied.join(', ') || 'none'}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
