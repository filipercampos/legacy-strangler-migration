import { type Kysely, type Transaction, sql } from 'kysely';
import { translateCustomer, translateInvoice } from '../acl/inbound';
import { AclRejection } from '../acl/legacy-codes';
import { DomainError } from '../billing/domain/errors';
import { customerColumns, invoiceColumns } from '../billing/persistence/mappers';
import type { Database } from '../shared/database/schema';
import { type Change, type StreamName, SYNC_CONTEXT } from './change-tracking';

export interface ProjectionStats {
  applied: number;
  tombstoned: number;
  deadLettered: number;
  echoesSkipped: number;
}

interface DeadLetter {
  legacyId: number;
  version: bigint;
  reason: string;
  detail: string;
  payload: unknown;
}

/**
 * Applies legacy changes to PostgreSQL through the inbound ACL. Shared by the backfill and
 * the CDC worker; always called inside the caller's transaction (together with the
 * checkpoint update).
 *
 * Idempotency: every upsert/tombstone is guarded by `source_version`, so re-applying a batch
 * after a crash, or applying an older snapshot over a newer CDC change, is a no-op.
 */
export class Projector {
  async project(
    trx: Transaction<Database> | Kysely<Database>,
    stream: StreamName,
    changes: Change[],
  ): Promise<ProjectionStats> {
    const stats: ProjectionStats = { applied: 0, tombstoned: 0, deadLettered: 0, echoesSkipped: 0 };
    const deadLetters: DeadLetter[] = [];
    // Single writer (ADR 0003): once modern owns an entity for a tenant, a legacy change to
    // it is a split-brain write (a forgotten caller, a SQL Agent job, a trigger). It is not
    // applied; it is dead-lettered and alarmed so the hidden writer gets found.
    const modernOwned = new Set(
      (
        await trx
          .selectFrom('entity_ownership')
          .select('tenant_id')
          .where('entity', '=', stream)
          .where('owner', '=', 'modern')
          .execute()
      ).map((row) => row.tenant_id),
    );
    const live = changes.filter((change) => {
      if (change.context === SYNC_CONTEXT) {
        stats.echoesSkipped += 1;
        return false;
      }
      const tenant = change.row?.CO_CODE.trim();
      if (tenant !== undefined && modernOwned.has(tenant)) {
        deadLetters.push({
          legacyId: change.key,
          version: change.version,
          reason: 'write_to_non_owner',
          detail: `${stream} for ${tenant} are owned by modern; legacy change ignored`,
          payload: change.row,
        });
        return false;
      }
      return true;
    });

    if (stream === 'customers') {
      await this.projectCustomers(trx, live, stats, deadLetters);
    } else {
      await this.projectInvoices(trx, live, stats, deadLetters);
    }

    // A row that now applies cleanly closes its earlier dead letters (e.g. an invoice that
    // looked orphaned during the backfill because its customer was created mid-copy).
    const rejected = new Set(deadLetters.map((letter) => letter.legacyId));
    const healed = live.map((change) => change.key).filter((key) => !rejected.has(key));
    if (healed.length > 0) {
      await trx
        .updateTable('sync_dead_letters')
        .set({ resolved_at: sql<Date>`now()` })
        .where('stream', '=', stream)
        .where('legacy_id', 'in', healed)
        .where('resolved_at', 'is', null)
        .execute();
    }

    if (deadLetters.length > 0) {
      await trx
        .insertInto('sync_dead_letters')
        .values(
          deadLetters.map((letter) => ({
            stream,
            legacy_id: letter.legacyId,
            source_version: letter.version,
            reason: letter.reason,
            detail: letter.detail,
            payload: JSON.stringify(letter.payload),
          })),
        )
        .onConflict((oc) => oc.columns(['stream', 'legacy_id', 'source_version']).doNothing())
        .execute();
      stats.deadLettered = deadLetters.length;
    }
    return stats;
  }

  private async projectCustomers(
    trx: Transaction<Database> | Kysely<Database>,
    changes: Change<'customers'>[],
    stats: ProjectionStats,
    deadLetters: DeadLetter[],
  ): Promise<void> {
    const upserts = [];
    const tombstones: { legacyId: number; version: bigint }[] = [];
    for (const change of changes) {
      if (!change.row) {
        tombstones.push({ legacyId: change.key, version: change.version });
        continue;
      }
      try {
        const result = translateCustomer(change.row);
        const snapshot = result.customer.snapshot;
        upserts.push({
          id: snapshot.id,
          ...customerColumns(snapshot),
          data_issues: result.issues,
          source_version: change.version,
          deleted_at: result.deleted ? new Date() : null,
        });
      } catch (error) {
        deadLetters.push(rejection(change, error));
      }
    }

    if (upserts.length > 0) {
      await trx
        .insertInto('customers')
        .values(upserts)
        .onConflict((oc) =>
          oc
            .column('legacy_id')
            .doUpdateSet((eb) => ({
              tenant_id: eb.ref('excluded.tenant_id'),
              name: eb.ref('excluded.name'),
              email: eb.ref('excluded.email'),
              document_kind: eb.ref('excluded.document_kind'),
              document_digits: eb.ref('excluded.document_digits'),
              status: eb.ref('excluded.status'),
              suspension_reason: eb.ref('excluded.suspension_reason'),
              registered_on: eb.ref('excluded.registered_on'),
              city: eb.ref('excluded.city'),
              state: eb.ref('excluded.state'),
              plan_code: eb.ref('excluded.plan_code'),
              plan_price_cents: eb.ref('excluded.plan_price_cents'),
              data_issues: eb.ref('excluded.data_issues'),
              source_version: eb.ref('excluded.source_version'),
              deleted_at: eb.ref('excluded.deleted_at'),
              updated_at: sql<Date>`now()`,
            }))
            .where('customers.source_version', '<', (eb) => eb.ref('excluded.source_version')),
        )
        .execute();
      stats.applied += upserts.length;
    }

    for (const tombstone of tombstones) {
      const result = await trx
        .updateTable('customers')
        .set({
          deleted_at: sql<Date>`now()`,
          source_version: tombstone.version,
          updated_at: sql<Date>`now()`,
        })
        .where('legacy_id', '=', tombstone.legacyId)
        .where('source_version', '<', tombstone.version)
        .executeTakeFirst();
      stats.tombstoned += Number(result.numUpdatedRows);
    }
  }

  private async projectInvoices(
    trx: Transaction<Database> | Kysely<Database>,
    changes: Change<'invoices'>[],
    stats: ProjectionStats,
    deadLetters: DeadLetter[],
  ): Promise<void> {
    const translated = [];
    for (const change of changes) {
      if (!change.row) {
        // Invoices are never hard-deleted in legacy; treat it as data loss to investigate.
        deadLetters.push({
          legacyId: change.key,
          version: change.version,
          reason: 'invoice_hard_deleted',
          detail: `TBL_INV row ${change.key} was deleted`,
          payload: null,
        });
        continue;
      }
      try {
        translated.push({ change, result: translateInvoice(change.row) });
      } catch (error) {
        deadLetters.push(rejection(change, error));
      }
    }
    if (translated.length === 0) return;

    // No FK in legacy: invoices may point at customers that never existed.
    const customerIds = [...new Set(translated.map((t) => t.result.invoice.snapshot.customerId))];
    const existing = new Set(
      (await trx.selectFrom('customers').select('id').where('id', 'in', customerIds).execute()).map(
        (row) => row.id,
      ),
    );

    const upserts = [];
    for (const { change, result } of translated) {
      const snapshot = result.invoice.snapshot;
      if (!existing.has(snapshot.customerId)) {
        deadLetters.push({
          legacyId: change.key,
          version: change.version,
          reason: 'orphan_invoice',
          detail: `CUST_ID ${result.legacyCustomerId} does not exist`,
          payload: change.row,
        });
        continue;
      }
      upserts.push({
        id: snapshot.id,
        ...invoiceColumns(snapshot),
        data_issues: result.issues,
        source_version: change.version,
      });
    }
    if (upserts.length === 0) return;

    await trx
      .insertInto('invoices')
      .values(upserts)
      .onConflict((oc) =>
        oc
          .column('legacy_id')
          .doUpdateSet((eb) => ({
            customer_id: eb.ref('excluded.customer_id'),
            period: eb.ref('excluded.period'),
            due_date: eb.ref('excluded.due_date'),
            amount_cents: eb.ref('excluded.amount_cents'),
            status: eb.ref('excluded.status'),
            void_reason: eb.ref('excluded.void_reason'),
            paid_on: eb.ref('excluded.paid_on'),
            notes: eb.ref('excluded.notes'),
            data_issues: eb.ref('excluded.data_issues'),
            source_version: eb.ref('excluded.source_version'),
            updated_at: sql<Date>`now()`,
          }))
          .where('invoices.source_version', '<', (eb) => eb.ref('excluded.source_version')),
      )
      .execute();
    stats.applied += upserts.length;
  }
}

function rejection(change: Change, error: unknown): DeadLetter {
  if (error instanceof AclRejection || error instanceof DomainError) {
    return {
      legacyId: change.key,
      version: change.version,
      reason: error instanceof AclRejection ? error.reason : error.code,
      detail: error.message,
      payload: change.row,
    };
  }
  throw error;
}
