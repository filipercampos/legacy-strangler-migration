import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Legacy-compatible ids for customers created by the modern service (disjoint from the
  // legacy IDENTITY range, see ADR 0003 / 0004).
  await sql`CREATE SEQUENCE modern_customer_legacy_id_seq START 50000000`.execute(db);

  // Transactional outbox for the reverse sync (modern -> legacy) while modern owns writes.
  await sql`
    CREATE TABLE reverse_sync_outbox (
      id         bigserial PRIMARY KEY,
      entity     text NOT NULL CHECK (entity IN ('customers')),
      legacy_id  integer NOT NULL,
      payload    jsonb NOT NULL,
      attempts   integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      synced_at  timestamptz
    )
  `.execute(db);
  await sql`
    CREATE INDEX reverse_sync_outbox_pending_idx ON reverse_sync_outbox (id) WHERE synced_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE reverse_sync_outbox`.execute(db);
  await sql`DROP SEQUENCE modern_customer_legacy_id_seq`.execute(db);
}
