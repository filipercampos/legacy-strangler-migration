import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type mssql from 'mssql';
import { pino } from 'pino';
import { connectLegacyDb, type LegacyDbOptions } from '../../src/legacy/db/connection';
import { runLegacyScripts } from '../../src/legacy/db/scripts';
import { createDatabase } from '../../src/shared/database/database';
import { migrateToLatest } from '../../src/shared/database/migrator';
import type { Database } from '../../src/shared/database/schema';

export const silentLogger = pino({ level: 'silent' });
export const discardMetrics = (): void => undefined;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set: is the integration globalSetup running?`);
  return value;
}

export function legacyOptions(database: string): LegacyDbOptions {
  return {
    host: env('TEST_MSSQL_HOST'),
    port: Number(env('TEST_MSSQL_PORT')),
    user: env('TEST_MSSQL_USER'),
    password: env('TEST_MSSQL_PASSWORD'),
    database,
    trustServerCertificate: true,
  };
}

/** Creates a fresh legacy database (schema, triggers, procedures, optional seed). */
export async function createLegacyDatabase(
  name: string,
  seedCustomers: number,
): Promise<mssql.ConnectionPool> {
  const options = legacyOptions(name);
  const master = await connectLegacyDb({ ...options, database: 'master' });
  try {
    await runLegacyScripts(
      master,
      () => connectLegacyDb(options),
      { DB_NAME: name, SEED_CUSTOMERS: String(seedCustomers) },
      { includeSeed: seedCustomers > 0 },
    );
  } finally {
    await master.close();
  }
  return connectLegacyDb(options);
}

/** Creates a fresh PostgreSQL database with all migrations applied. */
export async function createPgDatabase(
  name: string,
): Promise<{ db: Kysely<Database>; url: string }> {
  const admin = createDatabase({
    connectionString: env('TEST_PG_URL'),
    poolMax: 1,
    applicationName: 'test-admin',
  });
  await sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).execute(admin);
  await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
  await admin.destroy();

  const url = new URL(env('TEST_PG_URL'));
  url.pathname = `/${name}`;
  const db = createDatabase({
    connectionString: url.toString(),
    poolMax: 10,
    applicationName: 'test',
  });
  await migrateToLatest(db);
  return { db, url: url.toString() };
}

export async function exec(pool: mssql.ConnectionPool, statement: string): Promise<void> {
  await pool.request().batch(statement);
}
