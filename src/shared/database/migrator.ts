import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import * as m0001 from './migrations/0001_billing_core';
import * as m0002 from './migrations/0002_sync';
import * as m0003 from './migrations/0003_routing';
import * as m0004 from './migrations/0004_shadow';

/** Static provider: migrations are bundled with the code, no filesystem scanning at runtime. */
const migrations: Record<string, Migration> = {
  '0001_billing_core': m0001,
  '0002_sync': m0002,
  '0003_routing': m0003,
  '0004_shadow': m0004,
};

class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  }
}

export async function migrateToLatest<T>(db: Kysely<T>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((result) => result.status === 'Error')?.migrationName;
    throw new Error(
      `migration ${failed ?? '?'} failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }
  return (results ?? []).map((result) => result.migrationName);
}
