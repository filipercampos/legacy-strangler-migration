import type { CustomerProps } from '../billing/domain/customer';
import type { InvoiceProps } from '../billing/domain/invoice';
import { type LocalDate, formatTaxDocument } from '../billing/domain/values';
import type { LegacyCustomerDto, LegacyInvoiceDto } from '../legacy/contract';
import { customerStatusToLegacy, invoiceStatusToLegacy } from './legacy-codes';
import {
  centsToMoney,
  toLegacyCompact,
  toLegacyDmy,
  toLegacyReferenceMonth,
} from './legacy-formats';

/**
 * Outbound half of the anti-corruption layer: domain → legacy HTTP contract, used by the
 * compat endpoints so callers that still speak the legacy contract can be served by the
 * modern service. Output is canonical (always DD/MM/YYYY, always punctuated documents); the
 * shadow comparator normalizes the legacy side before comparing (ADR 0006).
 */
export function customerToLegacy(customer: Readonly<CustomerProps>): LegacyCustomerDto {
  return {
    CustId: customer.legacyId,
    CoCode: customer.tenantId,
    Name: customer.name,
    Email: customer.email,
    Doc: customer.document ? formatTaxDocument(customer.document) : null,
    Status: customerStatusToLegacy(customer.status),
    RegDate: customer.registeredOn ? toLegacyDmy(customer.registeredOn) : '',
    City: customer.city,
    Uf: customer.state,
    Plan: customer.plan?.code ?? null,
    PlanPrice: customer.plan ? centsToMoney(customer.plan.priceCents) : null,
  };
}

export function invoiceToLegacy(
  invoice: Readonly<InvoiceProps>,
  customer: { legacyId: number; name: string | null },
  today: LocalDate,
): LegacyInvoiceDto {
  const paidOn = invoice.status.kind === 'paid' ? invoice.status.paidOn : null;
  return {
    InvId: invoice.legacyId,
    CustId: customer.legacyId,
    CustName: customer.name,
    RefMonth: toLegacyReferenceMonth(invoice.period),
    DueDate: toLegacyCompact(invoice.dueDate),
    Amount: centsToMoney(invoice.amountCents),
    Status: invoiceStatusToLegacy(invoice.status, invoice.dueDate, today),
    PaidOn: paidOn ? toLegacyCompact(paidOn) : null,
    Notes: invoice.notes,
  };
}
