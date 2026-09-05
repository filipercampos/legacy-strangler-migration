import { gatewayEnvSchema, loadEnv, syncEnvSchema } from './env';

describe('loadEnv', () => {
  const legacy = {
    LEGACY_DB_HOST: 'localhost',
    LEGACY_DB_USER: 'sa',
    LEGACY_DB_PASSWORD: 'secret',
  };

  it('builds DATABASE_URL from the Secrets Manager fields injected by ECS', () => {
    const env = loadEnv(syncEnvSchema, {
      ...legacy,
      DB_HOST: 'aurora.cluster.local',
      DB_USERNAME: 'app',
      DB_PASSWORD: 'p@ss/word',
    });
    expect(env.DATABASE_URL).toBe(
      'postgres://app:p%40ss%2Fword@aurora.cluster.local:5432/billing?sslmode=require',
    );
    expect(env.SYNC_BATCH_SIZE).toBe(500);
    expect(env.LEGACY_DB_TRUST_CERT).toBe(false);
  });

  it('rejects a short admin token for the gateway', () => {
    expect(() =>
      loadEnv(gatewayEnvSchema, {
        DATABASE_URL: 'postgres://a:b@localhost:5434/billing',
        LEGACY_BASE_URL: 'http://localhost:3401',
        MODERN_BASE_URL: 'http://localhost:3402',
        ADMIN_TOKEN: 'short',
      }),
    ).toThrow(/ADMIN_TOKEN/);
  });
});
