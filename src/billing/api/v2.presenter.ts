import type { CustomerProps } from '../domain/customer';
import type { InvoiceProps } from '../domain/invoice';
import type { LocalDate } from '../domain/values';

const money = (cents: bigint) => ({
  amount: (Number(cents) / 100).toFixed(2),
  currency: 'BRL',
});

/** v2 representation: explicit names, ISO dates, decimal strings for money. */
export function presentCustomer(customer: Readonly<CustomerProps>) {
  return {
    id: customer.id,
    tenantId: customer.tenantId,
    legacyId: customer.legacyId,
    name: customer.name,
    email: customer.email,
    document: customer.document,
    status: customer.status.kind,
    suspensionReason: customer.status.kind === 'suspended' ? customer.status.reason : null,
    registeredOn: customer.registeredOn,
    address: { city: customer.city, state: customer.state },
    plan: customer.plan
      ? { code: customer.plan.code, price: money(customer.plan.priceCents) }
      : null,
  };
}

export function presentInvoice(invoice: Readonly<InvoiceProps>, today: LocalDate) {
  return {
    id: invoice.id,
    legacyId: invoice.legacyId,
    customerId: invoice.customerId,
    period: invoice.period,
    dueDate: invoice.dueDate,
    amount: money(invoice.amountCents),
    status: invoice.status.kind,
    overdue: invoice.status.kind === 'open' && invoice.dueDate < today,
    paidOn: invoice.status.kind === 'paid' ? invoice.status.paidOn : null,
    voidReason: invoice.status.kind === 'void' ? invoice.status.reason : null,
  };
}
