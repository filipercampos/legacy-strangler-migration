import type { CustomerStatus } from '../billing/domain/customer';
import type { InvoiceStatus } from '../billing/domain/invoice';
import type { LocalDate } from '../billing/domain/values';

/**
 * Single place where legacy magic codes are known. Every mapping is total in both directions
 * and unknown codes are rejected (dead-lettered), never defaulted.
 */
export class AclRejection extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'AclRejection';
  }
}

export type LegacyCustomerState = { kind: 'live'; status: CustomerStatus } | { kind: 'deleted' };

export function customerStatusFromLegacy(code: string): LegacyCustomerState {
  switch (code.trim().toUpperCase()) {
    case 'A':
      return { kind: 'live', status: { kind: 'active' } };
    case 'B':
      return { kind: 'live', status: { kind: 'suspended', reason: 'non_payment' } };
    case 'S':
      return { kind: 'live', status: { kind: 'suspended', reason: 'customer_request' } };
    case 'C':
      return { kind: 'live', status: { kind: 'closed' } };
    case 'X':
      return { kind: 'deleted' };
    default:
      throw new AclRejection('unknown_customer_status', `unknown CUST_STAT "${code}"`);
  }
}

export function customerStatusToLegacy(status: CustomerStatus): 'A' | 'B' | 'S' | 'C' {
  switch (status.kind) {
    case 'active':
      return 'A';
    case 'suspended':
      return status.reason === 'non_payment' ? 'B' : 'S';
    case 'closed':
      return 'C';
  }
}

export const LEGACY_INVOICE_STATUS = {
  open: 0,
  paid: 1,
  overdue: 2,
  writtenOff: 7,
  cancelled: 9,
} as const;

/** Legacy status + payment date → domain status. Overdue (2) is just "open" in the domain. */
export function invoiceStatusFromLegacy(code: number, paidOn: LocalDate | null): InvoiceStatus {
  switch (code) {
    case LEGACY_INVOICE_STATUS.open:
    case LEGACY_INVOICE_STATUS.overdue:
      return { kind: 'open' };
    case LEGACY_INVOICE_STATUS.paid:
      return { kind: 'paid', paidOn };
    case LEGACY_INVOICE_STATUS.writtenOff:
      return { kind: 'void', reason: 'written_off' };
    case LEGACY_INVOICE_STATUS.cancelled:
      return { kind: 'void', reason: 'cancelled' };
    default:
      throw new AclRejection('unknown_invoice_status', `unknown INV_STAT ${code}`);
  }
}

export function invoiceStatusToLegacy(
  status: InvoiceStatus,
  dueDate: LocalDate,
  today: LocalDate,
): number {
  switch (status.kind) {
    case 'open':
      return dueDate < today ? LEGACY_INVOICE_STATUS.overdue : LEGACY_INVOICE_STATUS.open;
    case 'paid':
      return LEGACY_INVOICE_STATUS.paid;
    case 'void':
      return status.reason === 'written_off'
        ? LEGACY_INVOICE_STATUS.writtenOff
        : LEGACY_INVOICE_STATUS.cancelled;
  }
}
