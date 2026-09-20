import type { Selectable } from 'kysely';
import type { CustomersTable, InvoicesTable } from '../../shared/database/schema';
import { Customer, type CustomerProps, type CustomerStatus } from '../domain/customer';
import { Invoice, type InvoiceProps, type InvoiceStatus } from '../domain/invoice';
import { type BillingPeriod, type Email, type LocalDate, type TaxDocument } from '../domain/values';

type CustomerRow = Selectable<CustomersTable>;
type InvoiceRow = Selectable<InvoicesTable>;

export function customerFromRow(row: CustomerRow): Customer {
  const status: CustomerStatus =
    row.status === 'suspended'
      ? { kind: 'suspended', reason: row.suspension_reason ?? 'customer_request' }
      : { kind: row.status };
  const document: TaxDocument | null =
    row.document_kind && row.document_digits
      ? { kind: row.document_kind, digits: row.document_digits }
      : null;
  return Customer.create({
    id: row.id,
    tenantId: row.tenant_id,
    legacyId: row.legacy_id,
    name: row.name,
    email: row.email as Email | null,
    document,
    status,
    registeredOn: row.registered_on as LocalDate | null,
    city: row.city,
    state: row.state,
    plan:
      row.plan_code !== null
        ? { code: row.plan_code, priceCents: row.plan_price_cents ?? 0n }
        : null,
  });
}

/** Column values for an insert/update (identity and bookkeeping columns excluded). */
export function customerColumns(customer: Readonly<CustomerProps>) {
  return {
    tenant_id: customer.tenantId,
    legacy_id: customer.legacyId,
    name: customer.name,
    email: customer.email,
    document_kind: customer.document?.kind ?? null,
    document_digits: customer.document?.digits ?? null,
    status: customer.status.kind,
    suspension_reason: customer.status.kind === 'suspended' ? customer.status.reason : null,
    registered_on: customer.registeredOn,
    city: customer.city,
    state: customer.state,
    plan_code: customer.plan?.code ?? null,
    plan_price_cents: customer.plan?.priceCents ?? null,
  };
}

export function invoiceFromRow(row: InvoiceRow): Invoice {
  let status: InvoiceStatus;
  if (row.status === 'paid') status = { kind: 'paid', paidOn: row.paid_on as LocalDate | null };
  else if (row.status === 'void') status = { kind: 'void', reason: row.void_reason ?? 'cancelled' };
  else status = { kind: 'open' };
  return Invoice.create({
    id: row.id,
    tenantId: row.tenant_id,
    legacyId: row.legacy_id,
    customerId: row.customer_id,
    period: row.period as BillingPeriod,
    dueDate: row.due_date as LocalDate,
    amountCents: row.amount_cents,
    status,
    notes: row.notes,
  });
}

export function invoiceColumns(invoice: Readonly<InvoiceProps>) {
  return {
    tenant_id: invoice.tenantId,
    legacy_id: invoice.legacyId,
    customer_id: invoice.customerId,
    period: invoice.period,
    due_date: invoice.dueDate,
    amount_cents: invoice.amountCents,
    status: invoice.status.kind,
    void_reason: invoice.status.kind === 'void' ? invoice.status.reason : null,
    paid_on: invoice.status.kind === 'paid' ? invoice.status.paidOn : null,
    notes: invoice.notes,
  };
}
