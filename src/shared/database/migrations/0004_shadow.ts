import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Full diff samples for investigation. Contains customer data: access is restricted to the
  // migration team role and rows older than 14 days are purged (runbook).
  await sql`
    CREATE TABLE shadow_mismatches (
      id          bigserial PRIMARY KEY,
      route_id    text NOT NULL,
      tenant_id   text NOT NULL,
      resource_id text,
      request_id  text,
      served_by   text NOT NULL,
      diff        jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX shadow_mismatches_route_idx ON shadow_mismatches (route_id, created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE shadow_mismatches`.execute(db);
}
