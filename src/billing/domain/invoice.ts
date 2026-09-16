import { InvalidTransitionError } from './errors';
import type { BillingPeriod, LocalDate } from './values';

export type VoidReason = 'cancelled' | 'written_off';

export type InvoiceStatus =
  | { kind: 'open' }
  /** paidOn is null only for legacy invoices marked paid without a payment date. */
  | { kind: 'paid'; paidOn: LocalDate | null }
  | { kind: 'void'; reason: VoidReason };

export interface InvoiceProps {
  id: string;
  tenantId: string;
  legacyId: number;
  customerId: string;
  period: BillingPeriod;
  dueDate: LocalDate;
  amountCents: bigint;
  status: InvoiceStatus;
  notes: string | null;
}

/**
 * Invoice aggregate. "Overdue" is not a stored state (legacy status 2 is written by a nightly
 * job and is therefore stale for up to a day): it is derived from the due date.
 */
export class Invoice {
  private constructor(private props: InvoiceProps) {}

  static create(props: InvoiceProps): Invoice {
    return new Invoice({ ...props });
  }

  get snapshot(): Readonly<InvoiceProps> {
    return { ...this.props };
  }

  isOverdue(today: LocalDate): boolean {
    return this.props.status.kind === 'open' && this.props.dueDate < today;
  }

  pay(on: LocalDate): void {
    if (this.props.status.kind !== 'open') {
      throw new InvalidTransitionError('invoice', this.props.status.kind, 'paid');
    }
    this.props.status = { kind: 'paid', paidOn: on };
  }

  void(reason: VoidReason): void {
    if (this.props.status.kind === 'paid') {
      throw new InvalidTransitionError('invoice', 'paid', 'void');
    }
    this.props.status = { kind: 'void', reason };
  }
}
