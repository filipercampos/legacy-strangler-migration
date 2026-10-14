import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import { translateCustomer } from '../../acl/inbound';
import { modernIdFor } from '../../acl/legacy-ids';
import { toLegacyDmy } from '../../acl/legacy-formats';
import { customerToLegacy } from '../../acl/outbound';
import type { LegacyCustomerDto, LegacyCustomerInput } from '../../legacy/contract';
import type { Database } from '../../shared/database/schema';
import { DB } from '../../shared/nest/tokens';
import { InvalidValueError, NotEntityOwnerError } from '../domain/errors';
import { Clock } from '../clock';
import { customerColumns, customerFromRow } from '../persistence/mappers';

/** Repairs the ACL tolerates on legacy data but that a new write must not introduce. */
const STRICT_ISSUES = ['email_invalid', 'document_invalid', 'state_invalid'];

/**
 * Customer writes on the modern side. Allowed only while the modern service is the single
 * writer for the tenant (ADR 0003): the ownership row is read FOR SHARE, so an ownership flip
 * (which updates that row) waits for in-flight writes and no write can straddle the flip.
 * Every write also enqueues the full legacy representation for the reverse sync, in the
 * same transaction (outbox).
 */
@Injectable()
export class CustomerWriteService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  async save(
    tenantId: string,
    legacyId: number | null,
    input: LegacyCustomerInput,
  ): Promise<LegacyCustomerDto> {
    return this.db.transaction().execute(async (trx) => {
      await this.assertOwner(trx, tenantId);

      let id = legacyId;
      let registered: string | null = toLegacyDmy(this.clock.today());
      if (id === null) {
        const next = await sql<{
          id: string;
        }>`SELECT nextval('modern_customer_legacy_id_seq') AS id`.execute(trx);
        id = Number(next.rows[0]?.id);
      } else {
        const existing = await trx
          .selectFrom('customers')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('legacy_id', '=', id)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!existing) throw new NotFoundException();
        const previous = customerFromRow(existing).snapshot.registeredOn;
        registered = previous ? toLegacyDmy(previous) : null;
      }

      const translation = translateCustomer({
        CUST_ID: id,
        CO_CODE: tenantId,
        CUST_NAME: input.Name,
        EMAIL: input.Email ?? null,
        DOC_NUM: input.Doc ?? null,
        CUST_STAT: input.Status ?? 'A',
        DT_REG: registered,
        CITY: input.City ?? null,
        UF: input.Uf ?? null,
        PLAN_CD: input.Plan ?? null,
        PLAN_PRICE: input.PlanPrice ?? null,
      });
      const strict = translation.issues.filter((issue) =>
        STRICT_ISSUES.some((prefix) => issue.startsWith(prefix)),
      );
      if (strict.length > 0) throw new InvalidValueError('customer', strict.join(', '));
      if (translation.deleted) throw new InvalidValueError('Status', 'use the delete operation');

      const snapshot = translation.customer.snapshot;
      const columns = customerColumns(snapshot);
      await trx
        .insertInto('customers')
        .values({
          id: modernIdFor('customer', id),
          ...columns,
          data_issues: translation.issues,
          // Never sourced from Change Tracking; CDC versions are always greater than 0.
          source_version: 0n,
        })
        .onConflict((oc) =>
          oc.column('legacy_id').doUpdateSet({ ...columns, updated_at: sql<Date>`now()` }),
        )
        .execute();

      const dto = customerToLegacy(snapshot);
      await trx
        .insertInto('reverse_sync_outbox')
        .values({ entity: 'customers', legacy_id: id, payload: JSON.stringify(dto) })
        .execute();
      return dto;
    });
  }

  private async assertOwner(trx: Transaction<Database>, tenantId: string): Promise<void> {
    const row = await trx
      .selectFrom('entity_ownership')
      .select('owner')
      .where('entity', '=', 'customers')
      .where('tenant_id', '=', tenantId)
      .forShare()
      .executeTakeFirst();
    const owner = row?.owner ?? 'legacy';
    if (owner !== 'modern') throw new NotEntityOwnerError('customers', tenantId, owner);
  }
}
