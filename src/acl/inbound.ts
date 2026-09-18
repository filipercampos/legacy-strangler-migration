import { Customer } from '../billing/domain/customer';
import { Invoice } from '../billing/domain/invoice';
import {
  type Email,
  type TaxDocument,
  email as parseEmail,
  taxDocument,
} from '../billing/domain/values';
import type { LegacyCustomerRow, LegacyInvoiceRow } from '../legacy/contract';
import { AclRejection, customerStatusFromLegacy, invoiceStatusFromLegacy } from './legacy-codes';
import {
  moneyToCents,
  parseCompactDate,
  parseReferenceMonth,
  parseRegistrationDate,
} from './legacy-formats';
import { modernIdFor } from './legacy-ids';

export type CustomerTranslation =
  | { kind: 'upsert'; customer: Customer; issues: string[] }
  | { kind: 'tombstone'; legacyId: number; tenantId: string; issues: string[] };

/**
 * Inbound half of the anti-corruption layer: legacy rows → domain aggregates.
 *
 * Policy: a value we can repair or drop without changing meaning (padded e-mail, punctuated
 * document, malformed optional date) becomes null/normalized plus a recorded issue. A value
 * whose meaning we cannot know (unknown status code, missing due date) rejects the row; the
 * sync worker dead-letters it.
 */
export function translateCustomer(row: LegacyCustomerRow): CustomerTranslation {
  const issues: string[] = [];
  const state = customerStatusFromLegacy(row.CUST_STAT);
  const tenantId = row.CO_CODE.trim();
  if (state.kind === 'deleted') {
    return { kind: 'tombstone', legacyId: row.CUST_ID, tenantId, issues };
  }

  const name = row.CUST_NAME?.trim();
  if (!name) throw new AclRejection('customer_name_missing', `CUST_ID ${row.CUST_ID} has no name`);

  const registered = parseRegistrationDate(row.DT_REG);
  if (registered.issue) issues.push(registered.issue);

  let price: bigint | null = null;
  if (row.PLAN_PRICE !== null) {
    const parsed = moneyToCents(row.PLAN_PRICE);
    if (parsed.issue) issues.push(`plan_price:${parsed.issue}`);
    price = parsed.value;
  }

  const uf = row.UF?.trim().toUpperCase() || null;
  const validState = uf !== null && /^[A-Z]{2}$/.test(uf) ? uf : null;
  if (uf !== null && validState === null) issues.push(`state_invalid:${uf}`);

  const customer = Customer.create({
    id: modernIdFor('customer', row.CUST_ID),
    tenantId,
    legacyId: row.CUST_ID,
    name,
    email: lenient(row.EMAIL, parseEmail, 'email_invalid', issues),
    document: lenient(row.DOC_NUM, taxDocument, 'document_invalid', issues),
    status: state.status,
    registeredOn: registered.value,
    city: row.CITY?.trim() || null,
    state: validState,
    plan: row.PLAN_CD?.trim() ? { code: row.PLAN_CD.trim(), priceCents: price ?? 0n } : null,
  });
  return { kind: 'upsert', customer, issues };
}

export interface InvoiceTranslation {
  invoice: Invoice;
  /** Legacy CUST_ID, kept to detect orphans (no FK in the legacy schema). */
  legacyCustomerId: number;
  issues: string[];
}

export function translateInvoice(row: LegacyInvoiceRow): InvoiceTranslation {
  const issues: string[] = [];
  const period = parseReferenceMonth(row.REF_MONTH);
  if (!period) {
    throw new AclRejection('reference_month_invalid', `INV_ID ${row.INV_ID}: "${row.REF_MONTH}"`);
  }
  const due = parseCompactDate(row.DUE_DT);
  if (!due.value)
    throw new AclRejection('due_date_invalid', `INV_ID ${row.INV_ID}: "${row.DUE_DT}"`);

  const paid = parseCompactDate(row.PAY_DT);
  if (paid.issue) issues.push(paid.issue);
  if (row.INV_STAT === 1 && !paid.value) issues.push('paid_without_payment_date');

  const amount = moneyToCents(row.AMT);
  if (amount.issue) issues.push(amount.issue);
  if (amount.value === null || amount.value < 0n) {
    throw new AclRejection('amount_negative', `INV_ID ${row.INV_ID}: ${row.AMT}`);
  }

  const invoice = Invoice.create({
    id: modernIdFor('invoice', row.INV_ID),
    tenantId: row.CO_CODE.trim(),
    legacyId: row.INV_ID,
    customerId: modernIdFor('customer', row.CUST_ID),
    period,
    dueDate: due.value,
    amountCents: amount.value,
    status: invoiceStatusFromLegacy(row.INV_STAT, paid.value),
    notes: row.NOTES?.trim() || null,
  });
  return { invoice, legacyCustomerId: row.CUST_ID, issues };
}

function lenient<T extends TaxDocument | Email>(
  raw: string | null,
  parse: (value: string) => T,
  issue: string,
  issues: string[],
): T | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    return parse(raw);
  } catch {
    issues.push(issue);
    return null;
  }
}
