import { localDate } from '../billing/domain/values';
import type { LegacyCustomerRow, LegacyInvoiceRow } from '../legacy/contract';
import { translateCustomer, translateInvoice } from './inbound';
import { AclRejection, customerStatusFromLegacy, customerStatusToLegacy } from './legacy-codes';
import { moneyToCents, parseCompactDate, parseRegistrationDate } from './legacy-formats';
import { modernIdFor } from './legacy-ids';
import { customerToLegacy, invoiceToLegacy } from './outbound';

const customerRow = (overrides: Partial<LegacyCustomerRow> = {}): LegacyCustomerRow => ({
  CUST_ID: 17,
  CO_CODE: 'ACME',
  CUST_NAME: 'Customer 17',
  EMAIL: ' CUSTOMER17@EXAMPLE.COM ',
  DOC_NUM: '123.456.789-01',
  CUST_STAT: 'B',
  DT_REG: '2019-05-31',
  CITY: 'Curitiba',
  UF: 'PR',
  PLAN_CD: 'PRO',
  PLAN_PRICE: 99.9,
  ...overrides,
});

const invoiceRow = (overrides: Partial<LegacyInvoiceRow> = {}): LegacyInvoiceRow => ({
  INV_ID: 3017,
  CUST_ID: 17,
  CO_CODE: 'ACME',
  CUST_NAME: 'Customer 17',
  REF_MONTH: '08/2026',
  DUE_DT: '20260810',
  AMT: 99.9,
  INV_STAT: 2,
  PAY_DT: '00000000',
  NOTES: null,
  ...overrides,
});

describe('legacy formats', () => {
  it('reads both registration date formats and flags impossible dates', () => {
    expect(parseRegistrationDate('21/08/2026')).toEqual({ value: '2026-08-21' });
    expect(parseRegistrationDate('2026-08-11')).toEqual({ value: '2026-08-11' });
    expect(parseRegistrationDate('31/02/2019')).toEqual({
      value: null,
      issue: 'registration_date_invalid:31/02/2019',
    });
    expect(parseRegistrationDate('')).toEqual({ value: null, issue: 'registration_date_missing' });
  });

  it('treats NULL, empty and 00000000 as "no date"', () => {
    for (const raw of [null, '', '00000000'])
      expect(parseCompactDate(raw)).toEqual({ value: null });
    expect(parseCompactDate('20261340').issue).toBe('compact_date_invalid:20261340');
  });

  it('converts MONEY to cents without float drift', () => {
    expect(moneyToCents(99.9)).toEqual({ value: 9990n });
    expect(moneyToCents(0.07)).toEqual({ value: 7n });
    expect(moneyToCents(10.0051)).toEqual({ value: 1001n, issue: 'amount_rounded' });
  });
});

describe('status codes', () => {
  it('round-trips every live customer code', () => {
    for (const code of ['A', 'B', 'S', 'C']) {
      const state = customerStatusFromLegacy(code);
      if (state.kind !== 'live') throw new Error('expected live');
      expect(customerStatusToLegacy(state.status)).toBe(code);
    }
  });

  it('rejects unknown codes instead of defaulting them', () => {
    expect(() => customerStatusFromLegacy('Z')).toThrow(AclRejection);
    expect(() => translateInvoice(invoiceRow({ INV_STAT: 5 }))).toThrow(AclRejection);
  });
});

describe('inbound translation', () => {
  it('normalizes a messy customer row and records what it repaired', () => {
    const result = translateCustomer(customerRow({ DOC_NUM: 'ISENTO' }));
    if (result.kind !== 'upsert') throw new Error('expected upsert');
    const customer = result.customer.snapshot;
    expect(customer.id).toBe(modernIdFor('customer', 17));
    expect(customer.email).toBe('customer17@example.com');
    expect(customer.document).toBeNull();
    expect(customer.status).toEqual({ kind: 'suspended', reason: 'non_payment' });
    expect(customer.registeredOn).toBe('2019-05-31');
    expect(customer.plan).toEqual({ code: 'PRO', priceCents: 9990n });
    expect(result.issues).toEqual(['document_invalid']);
  });

  it('turns soft-deleted rows into tombstones', () => {
    expect(translateCustomer(customerRow({ CUST_STAT: 'X' }))).toEqual({
      kind: 'tombstone',
      legacyId: 17,
      tenantId: 'ACME',
      issues: [],
    });
  });

  it('maps overdue to open and keeps paid invoices without a date', () => {
    const overdue = translateInvoice(invoiceRow()).invoice.snapshot;
    expect(overdue.status).toEqual({ kind: 'open' });
    expect(overdue.customerId).toBe(modernIdFor('customer', 17));

    const paid = translateInvoice(invoiceRow({ INV_STAT: 1, PAY_DT: '' }));
    expect(paid.invoice.snapshot.status).toEqual({ kind: 'paid', paidOn: null });
    expect(paid.issues).toContain('paid_without_payment_date');
  });

  it('rejects invoices whose due date cannot be known', () => {
    expect(() => translateInvoice(invoiceRow({ DUE_DT: '2026-08-10' }))).toThrow(
      expect.objectContaining({ reason: 'due_date_invalid' }),
    );
  });
});

describe('outbound translation', () => {
  it('emits the legacy contract from the domain', () => {
    const translated = translateCustomer(customerRow());
    if (translated.kind !== 'upsert') throw new Error('expected upsert');
    expect(customerToLegacy(translated.customer.snapshot)).toEqual({
      CustId: 17,
      CoCode: 'ACME',
      Name: 'Customer 17',
      Email: 'customer17@example.com',
      Doc: '123.456.789-01',
      Status: 'B',
      RegDate: '31/05/2019',
      City: 'Curitiba',
      Uf: 'PR',
      Plan: 'PRO',
      PlanPrice: 99.9,
    });
  });

  it('derives overdue from the due date at read time', () => {
    const invoice = translateInvoice(invoiceRow({ INV_STAT: 0 })).invoice.snapshot;
    const customer = { legacyId: 17, name: 'Customer 17' };
    expect(invoiceToLegacy(invoice, customer, localDate('2026-08-10')).Status).toBe(0);
    expect(invoiceToLegacy(invoice, customer, localDate('2026-08-11')).Status).toBe(2);
    expect(invoiceToLegacy(invoice, customer, localDate('2026-08-11'))).toMatchObject({
      RefMonth: '08/2026',
      DueDate: '20260810',
      Amount: 99.9,
      PaidOn: null,
    });
  });
});
