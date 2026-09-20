import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import * as m0001 from './migrations/0001_billing_core';

/** Static provider: migrations are bundled with the code, no filesystem scanning at runtime. */
const migrations: Record<string, Migration> = {
  '0001_billing_core': m0001,
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
