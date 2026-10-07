import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Read routing per route and tenant ('*' = default for all tenants).
  await sql`
    CREATE TABLE routing_rules (
      route_id       text NOT NULL,
      tenant_id      text NOT NULL,
      modern_percent smallint NOT NULL DEFAULT 0 CHECK (modern_percent BETWEEN 0 AND 100),
      shadow_percent smallint NOT NULL DEFAULT 0 CHECK (shadow_percent BETWEEN 0 AND 100),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      updated_by     text NOT NULL,
      PRIMARY KEY (route_id, tenant_id)
    )
  `.execute(db);

  // Single writer per entity and tenant (ADR 0003). Absent row = legacy owns it.
  await sql`
    CREATE TABLE entity_ownership (
      entity     text NOT NULL CHECK (entity IN ('customers', 'invoices')),
      tenant_id  text NOT NULL,
      owner      text NOT NULL CHECK (owner IN ('legacy', 'modern')),
      changed_at timestamptz NOT NULL DEFAULT now(),
      changed_by text NOT NULL,
      PRIMARY KEY (entity, tenant_id)
    )
  `.execute(db);

  // Global kill switch: everything to legacy, no shadow traffic.
  await sql`
    CREATE TABLE gateway_settings (
      id          boolean PRIMARY KEY DEFAULT true CHECK (id),
      kill_switch boolean NOT NULL DEFAULT false,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text NOT NULL DEFAULT 'migration'
    )
  `.execute(db);
  await sql`INSERT INTO gateway_settings DEFAULT VALUES`.execute(db);

  // Append-only audit of every routing / ownership change (who moved traffic, when).
  await sql`
    CREATE TABLE routing_audit (
      id         bigserial PRIMARY KEY,
      actor      text NOT NULL,
      action     text NOT NULL,
      detail     jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE routing_audit`.execute(db);
  await sql`DROP TABLE gateway_settings`.execute(db);
  await sql`DROP TABLE entity_ownership`.execute(db);
  await sql`DROP TABLE routing_rules`.execute(db);
}
