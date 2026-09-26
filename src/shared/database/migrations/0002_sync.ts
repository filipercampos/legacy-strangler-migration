import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // One row per stream ('cdc:customers', 'backfill:customers', ...). Advanced in the same
  // transaction as the rows it covers, which is what makes a crash at any point safe.
  await sql`
    CREATE TABLE sync_checkpoints (
      stream     text PRIMARY KEY,
      position   bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE sync_dead_letters (
      id             bigserial PRIMARY KEY,
      stream         text NOT NULL,
      legacy_id      integer NOT NULL,
      source_version bigint NOT NULL,
      reason         text NOT NULL,
      detail         text,
      payload        jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      resolved_at    timestamptz,
      UNIQUE (stream, legacy_id, source_version)
    )
  `.execute(db);
  await sql`
    CREATE INDEX sync_dead_letters_open_idx ON sync_dead_letters (stream, created_at)
     WHERE resolved_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sync_dead_letters`.execute(db);
  await sql`DROP TABLE sync_checkpoints`.execute(db);
}
