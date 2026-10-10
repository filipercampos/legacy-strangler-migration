import { parseCompactDate, parseRegistrationDate } from '../../acl/legacy-formats';
import { email as parseEmail, taxDocument } from '../../billing/domain/values';
import type { LegacyCustomerDto, LegacyInvoiceDto } from '../../legacy/contract';

/**
 * Canonical forms for semantic comparison of legacy vs modern responses. Each rule removes
 * one *accepted* difference (decided in ADR 0006), so whatever still differs afterwards is
 * a real mismatch: sync lag, a translation bug, or a behaviour nobody knew about.
 *
 *  - formatting: e-mail case/padding, punctuated vs bare documents, DD/MM/YYYY vs ISO dates
 *  - lossy cleanup: invalid documents and impossible dates are null on both sides
 *  - "unpaid" spelled NULL, '' or '00000000'
 *  - overdue (2) vs open (0): legacy only flips it in a nightly batch
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const text = (value: string | null | undefined): string | null => value?.trim() || null;

function canonicalEmail(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    return parseEmail(value);
  } catch {
    return `invalid:${value.trim()}`;
  }
}

function canonicalDocument(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    return taxDocument(value).digits;
  } catch {
    return null;
  }
}

const cents = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100);

export function canonicalCustomer(dto: LegacyCustomerDto): Json {
  return {
    CustId: dto.CustId,
    CoCode: dto.CoCode,
    Name: text(dto.Name),
    Email: canonicalEmail(dto.Email),
    Doc: canonicalDocument(dto.Doc),
    Status: dto.Status,
    RegDate: parseRegistrationDate(dto.RegDate).value,
    City: text(dto.City),
    Uf: text(dto.Uf),
    Plan: text(dto.Plan),
    PlanPrice: cents(dto.PlanPrice),
  };
}

export function canonicalInvoice(dto: LegacyInvoiceDto): Json {
  return {
    InvId: dto.InvId,
    CustId: dto.CustId,
    CustName: text(dto.CustName),
    RefMonth: dto.RefMonth,
    DueDate: dto.DueDate,
    Amount: cents(dto.Amount),
    Status: dto.Status === 0 || dto.Status === 2 ? 'open' : dto.Status,
    PaidOn: parseCompactDate(dto.PaidOn).value,
    Notes: text(dto.Notes),
  };
}

export function canonicalBody(routeId: string, body: unknown): Json {
  switch (routeId) {
    case 'customers.get':
      return canonicalCustomer(body as LegacyCustomerDto);
    case 'customers.list':
      return { Items: (body as { Items: LegacyCustomerDto[] }).Items.map(canonicalCustomer) };
    case 'invoices.list':
      return { Items: (body as { Items: LegacyInvoiceDto[] }).Items.map(canonicalInvoice) };
    default:
      return body as Json;
  }
}
