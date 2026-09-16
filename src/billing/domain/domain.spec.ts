import { Customer, type CustomerProps } from './customer';
import { InvalidTransitionError, InvalidValueError } from './errors';
import { Invoice } from './invoice';
import { billingPeriod, email, formatTaxDocument, localDate, taxDocument } from './values';

const customerProps = (overrides: Partial<CustomerProps> = {}): CustomerProps => ({
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: 'ACME',
  legacyId: 42,
  name: 'Customer 42',
  email: email('c42@example.com'),
  document: taxDocument('123.456.789-01'),
  status: { kind: 'active' },
  registeredOn: localDate('2024-02-29'),
  city: 'Curitiba',
  state: 'PR',
  plan: { code: 'PRO', priceCents: 9990n },
  ...overrides,
});

describe('value objects', () => {
  it('rejects dates that do not exist on the calendar', () => {
    expect(localDate('2024-02-29')).toBe('2024-02-29');
    expect(() => localDate('2019-02-31')).toThrow(InvalidValueError);
    expect(() => localDate('31/02/2019')).toThrow(InvalidValueError);
  });

  it('normalizes CPF and CNPJ regardless of punctuation', () => {
    expect(taxDocument('123.456.789-01')).toEqual({ kind: 'cpf', digits: '12345678901' });
    const cnpj = taxDocument('10.000.001/0472-90');
    expect(cnpj).toEqual({ kind: 'cnpj', digits: '10000001047290' });
    expect(formatTaxDocument(cnpj)).toBe('10.000.001/0472-90');
    expect(() => taxDocument('ISENTO')).toThrow(InvalidValueError);
    expect(() => taxDocument('11111111111')).toThrow(InvalidValueError);
  });

  it('normalizes e-mail case and padding', () => {
    expect(email(' CUSTOMER17@EXAMPLE.COM ')).toBe('customer17@example.com');
    expect(() => email('not-an-email')).toThrow(InvalidValueError);
  });

  it('accepts only YYYY-MM billing periods', () => {
    expect(billingPeriod('2026-08')).toBe('2026-08');
    expect(() => billingPeriod('08/2026')).toThrow(InvalidValueError);
  });
});

describe('Customer', () => {
  it('trims the name and validates the UF', () => {
    expect(Customer.create(customerProps({ name: '  Acme  ' })).snapshot.name).toBe('Acme');
    expect(() => Customer.create(customerProps({ state: 'Parana' }))).toThrow(InvalidValueError);
  });

  it('only reactivates a suspended customer and never reopens a closed one', () => {
    const customer = Customer.create(customerProps());
    expect(() => customer.reactivate()).toThrow(InvalidTransitionError);
    customer.suspend('non_payment');
    customer.reactivate();
    customer.close();
    expect(() => customer.suspend('customer_request')).toThrow(InvalidTransitionError);
  });
});

describe('Invoice', () => {
  const invoice = () =>
    Invoice.create({
      id: '00000000-0000-4000-8000-000000000002',
      tenantId: 'ACME',
      legacyId: 7,
      customerId: '00000000-0000-4000-8000-000000000001',
      period: billingPeriod('2026-08'),
      dueDate: localDate('2026-08-10'),
      amountCents: 9990n,
      status: { kind: 'open' },
      notes: null,
    });

  it('derives overdue from the due date instead of storing it', () => {
    expect(invoice().isOverdue(localDate('2026-08-10'))).toBe(false);
    expect(invoice().isOverdue(localDate('2026-08-11'))).toBe(true);
  });

  it('cannot void a paid invoice or pay twice', () => {
    const paid = invoice();
    paid.pay(localDate('2026-08-09'));
    expect(paid.isOverdue(localDate('2026-09-01'))).toBe(false);
    expect(() => paid.pay(localDate('2026-08-10'))).toThrow(InvalidTransitionError);
    expect(() => paid.void('cancelled')).toThrow(InvalidTransitionError);
  });
});
