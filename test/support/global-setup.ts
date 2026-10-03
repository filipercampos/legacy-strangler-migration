import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export const MSSQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04';
export const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * One SQL Server and one PostgreSQL container for the whole integration run (SQL Server
 * needs ~2 GB of RAM and ~20 s to start, too much to repeat per suite). Every suite creates
 * its own databases inside them, so suites stay isolated.
 */
export default async function globalSetup(): Promise<void> {
  const [mssql, postgres] = await Promise.all([
    new MSSQLServerContainer(MSSQL_IMAGE)
      .acceptLicense()
      .withPassword('Strangler_Test_1!')
      .withEnvironment({ MSSQL_MEMORY_LIMIT_MB: '1536' })
      .start(),
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
  ]);

  Object.assign(process.env, {
    TEST_MSSQL_HOST: mssql.getHost(),
    TEST_MSSQL_PORT: String(mssql.getPort()),
    TEST_MSSQL_USER: mssql.getUsername(),
    TEST_MSSQL_PASSWORD: 'Strangler_Test_1!',
    TEST_PG_URL: postgres.getConnectionUri(),
  });
  (globalThis as { __containers__?: { stop(): Promise<unknown> }[] }).__containers__ = [
    mssql,
    postgres,
  ];
}
