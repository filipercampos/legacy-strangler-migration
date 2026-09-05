import { z } from 'zod';

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/** Fields every process shares (gateway, billing service, sync worker, legacy app). */
const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

const postgres = {
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
};

const legacyDb = {
  LEGACY_DB_HOST: z.string().min(1),
  LEGACY_DB_PORT: z.coerce.number().int().positive().default(1433),
  LEGACY_DB_USER: z.string().min(1),
  LEGACY_DB_PASSWORD: z.string().min(1),
  LEGACY_DB_NAME: z.string().min(1).default('LegacyBilling'),
  // RDS SQL Server uses a certificate signed by the RDS CA; locally the container is self-signed.
  LEGACY_DB_TRUST_CERT: bool('false'),
};

export const legacyAppEnvSchema = z.object({
  ...common,
  ...legacyDb,
  PORT: z.coerce.number().int().positive().default(3401),
});

export const billingEnvSchema = z.object({
  ...common,
  ...postgres,
  PORT: z.coerce.number().int().positive().default(3402),
});

export const gatewayEnvSchema = z.object({
  ...common,
  ...postgres,
  PORT: z.coerce.number().int().positive().default(3400),
  LEGACY_BASE_URL: z.string().url(),
  MODERN_BASE_URL: z.string().url(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  SHADOW_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
  FLAG_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(2_000),
  ADMIN_TOKEN: z.string().min(16),
});

export const syncEnvSchema = z.object({
  ...common,
  ...postgres,
  ...legacyDb,
  SYNC_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(5_000).default(500),
  BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(1_000),
  BACKFILL_MAX_ROWS_PER_SECOND: z.coerce.number().int().positive().default(2_000),
  PARITY_BUCKET_SIZE: z.coerce.number().int().positive().default(1_000),
});

export type LegacyAppEnv = z.infer<typeof legacyAppEnvSchema>;
export type BillingEnv = z.infer<typeof billingEnvSchema>;
export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;
export type SyncEnv = z.infer<typeof syncEnvSchema>;

/**
 * In ECS, secrets are injected as separate fields by Secrets Manager (DB_HOST, DB_USERNAME,
 * DB_PASSWORD for Aurora). Locally a single DATABASE_URL is simpler.
 */
function withDatabaseUrl(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.DATABASE_URL || !source.DB_HOST) return source;
  const user = encodeURIComponent(source.DB_USERNAME ?? '');
  const password = encodeURIComponent(source.DB_PASSWORD ?? '');
  const name = source.DB_NAME ?? 'billing';
  return {
    ...source,
    DATABASE_URL: `postgres://${user}:${password}@${source.DB_HOST}:5432/${name}?sslmode=require`,
  };
}

export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const parsed = schema.safeParse(withDatabaseUrl(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data as z.infer<T>;
}
