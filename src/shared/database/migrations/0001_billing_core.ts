import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE customers (
      id                uuid PRIMARY KEY,
      tenant_id         text NOT NULL,
      legacy_id         integer NOT NULL UNIQUE,
      name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      email             text,
      document_kind     text CHECK (document_kind IN ('cpf', 'cnpj')),
      document_digits   text,
      status            text NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
      suspension_reason text CHECK (suspension_reason IN ('non_payment', 'customer_request')),
      registered_on     date,
      city              text,
      state             char(2),
      plan_code         text,
      plan_price_cents  bigint CHECK (plan_price_cents >= 0),
      data_issues       text[] NOT NULL DEFAULT '{}',
      source_version    bigint NOT NULL,
      deleted_at        timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT suspension_reason_iff_suspended
        CHECK ((status = 'suspended') = (suspension_reason IS NOT NULL)),
      CONSTRAINT document_complete
        CHECK ((document_kind IS NULL) = (document_digits IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX customers_tenant_legacy_idx ON customers (tenant_id, legacy_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE invoices (
      id             uuid PRIMARY KEY,
      tenant_id      text NOT NULL,
      legacy_id      integer NOT NULL UNIQUE,
      customer_id    uuid NOT NULL REFERENCES customers (id),
      period         char(7) NOT NULL CHECK (period ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
      due_date       date NOT NULL,
      amount_cents   bigint NOT NULL CHECK (amount_cents >= 0),
      status         text NOT NULL CHECK (status IN ('open', 'paid', 'void')),
      void_reason    text CHECK (void_reason IN ('cancelled', 'written_off')),
      paid_on        date,
      notes          text,
      data_issues    text[] NOT NULL DEFAULT '{}',
      source_version bigint NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT void_reason_iff_void CHECK ((status = 'void') = (void_reason IS NOT NULL)),
      CONSTRAINT paid_on_only_when_paid CHECK (status = 'paid' OR paid_on IS NULL)
    )
  `.execute(db);
  await sql`CREATE INDEX invoices_customer_idx ON invoices (customer_id, legacy_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE invoices`.execute(db);
  await sql`DROP TABLE customers`.execute(db);
}
