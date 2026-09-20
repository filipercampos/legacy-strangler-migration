import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

// int8 (cents, change-tracking versions) as bigint; DATE as the ISO string, never a JS Date
// shifted by the process time zone.
types.setTypeParser(types.builtins.INT8, (value: string) => BigInt(value));
types.setTypeParser(types.builtins.DATE, (value: string) => value);

export interface DatabaseOptions {
  connectionString: string;
  poolMax: number;
  applicationName: string;
}

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
