import sql from 'mssql';

export interface LegacyDbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  trustServerCertificate: boolean;
  poolMax?: number;
  appName?: string;
}

export function legacyDbOptionsFromEnv(env: {
  LEGACY_DB_HOST: string;
  LEGACY_DB_PORT: number;
  LEGACY_DB_USER: string;
  LEGACY_DB_PASSWORD: string;
  LEGACY_DB_NAME: string;
  LEGACY_DB_TRUST_CERT: boolean;
}): LegacyDbOptions {
  return {
    host: env.LEGACY_DB_HOST,
    port: env.LEGACY_DB_PORT,
    user: env.LEGACY_DB_USER,
    password: env.LEGACY_DB_PASSWORD,
    database: env.LEGACY_DB_NAME,
    trustServerCertificate: env.LEGACY_DB_TRUST_CERT,
  };
}

export async function connectLegacyDb(options: LegacyDbOptions): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    pool: { max: options.poolMax ?? 10, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    options: {
      encrypt: true,
      trustServerCertificate: options.trustServerCertificate,
      appName: options.appName ?? 'legacy-strangler-migration',
    },
  });
  return pool.connect();
}
