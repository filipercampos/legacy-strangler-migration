import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../shared/database/schema';
import { DB } from '../../shared/nest/tokens';
import type { Customer } from '../domain/customer';
import type { Invoice } from '../domain/invoice';
import { customerFromRow, invoiceFromRow } from './mappers';

@Injectable()
export class BillingRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async findCustomerById(tenantId: string, id: string): Promise<Customer | null> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? customerFromRow(row) : null;
  }

  async findCustomerByLegacyId(tenantId: string, legacyId: number): Promise<Customer | null> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('legacy_id', '=', legacyId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row ? customerFromRow(row) : null;
  }

  /** Keyset pagination on the legacy id, the order legacy callers already rely on. */
  async listCustomers(tenantId: string, afterLegacyId: number, limit: number): Promise<Customer[]> {
    const rows = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('legacy_id', '>', afterLegacyId)
      .where('deleted_at', 'is', null)
      .orderBy('legacy_id')
      .limit(limit)
      .execute();
    return rows.map(customerFromRow);
  }

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const rows = await this.db
      .selectFrom('invoices')
      .selectAll()
      .where('customer_id', '=', customerId)
      .orderBy('legacy_id')
      .execute();
    return rows.map(invoiceFromRow);
  }
}
