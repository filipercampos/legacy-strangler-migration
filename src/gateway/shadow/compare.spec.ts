import type { LegacyCustomerDto, LegacyInvoiceDto } from '../../legacy/contract';
import { compareResponses, deepDiff } from './compare';

const legacyCustomer: LegacyCustomerDto = {
  CustId: 17,
  CoCode: 'ACME',
  Name: 'Customer 17',
  Email: ' CUSTOMER17@EXAMPLE.COM ',
  Doc: '12345678901',
  Status: 'B',
  RegDate: '2019-05-31',
  City: 'Curitiba',
  Uf: 'PR',
  Plan: 'PRO',
  PlanPrice: 99.9,
};

const modernCustomer: LegacyCustomerDto = {
  ...legacyCustomer,
  Email: 'customer17@example.com',
  Doc: '123.456.789-01',
  RegDate: '31/05/2019',
};

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

describe('deepDiff', () => {
  it('reports paths of differing leaves, including missing keys and array items', () => {
    expect(deepDiff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3], c: true })).toEqual([
      { path: '$.b[1]', legacy: 2, modern: 3 },
      { path: '$.c', legacy: undefined, modern: true },
    ]);
  });
});

describe('compareResponses', () => {
  it('treats formatting-only differences as equal', () => {
    expect(compareResponses('customers.get', ok(legacyCustomer), ok(modernCustomer))).toEqual([]);
  });

  it('accepts documented lossy cleanups (invalid document, impossible date)', () => {
    const legacy = { ...legacyCustomer, Doc: 'ISENTO', RegDate: '31/02/2019' };
    const modern = { ...modernCustomer, Doc: null, RegDate: '' };
    expect(compareResponses('customers.get', ok(legacy), ok(modern))).toEqual([]);
  });

  it('flags a real difference with its path', () => {
    const modern = { ...modernCustomer, Status: 'A', PlanPrice: 49.9 };
    expect(compareResponses('customers.get', ok(legacyCustomer), ok(modern))).toEqual([
      { path: '$.PlanPrice', legacy: 9990, modern: 4990 },
      { path: '$.Status', legacy: 'B', modern: 'A' },
    ]);
  });

  it('treats overdue/open and the three spellings of "unpaid" as equal', () => {
    const invoice: LegacyInvoiceDto = {
      InvId: 1,
      CustId: 17,
      CustName: 'Customer 17',
      RefMonth: '08/2026',
      DueDate: '20260810',
      Amount: 99.9,
      Status: 0,
      PaidOn: '00000000',
      Notes: null,
    };
    expect(
      compareResponses(
        'invoices.list',
        ok({ Items: [invoice] }),
        ok({ Items: [{ ...invoice, Status: 2, PaidOn: null }] }),
      ),
    ).toEqual([]);
    expect(
      compareResponses(
        'invoices.list',
        ok({ Items: [invoice] }),
        ok({ Items: [{ ...invoice, Status: 1, PaidOn: '20260809' }] }),
      ).map((d) => d.path),
    ).toEqual(['$.Items[0].PaidOn', '$.Items[0].Status']);
  });

  it('compares status codes, and only status codes for errors', () => {
    expect(
      compareResponses('customers.get', { status: 404, body: 'a' }, { status: 404, body: 'b' }),
    ).toEqual([]);
    expect(
      compareResponses('customers.get', ok(legacyCustomer), { status: 404, body: '' }),
    ).toEqual([{ path: '$status', legacy: 200, modern: 404 }]);
  });
});
