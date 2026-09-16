import { InvalidTransitionError, InvalidValueError } from './errors';
import type { Email, LocalDate, TaxDocument } from './values';

export type SuspensionReason = 'non_payment' | 'customer_request';

export type CustomerStatus =
  { kind: 'active' } | { kind: 'suspended'; reason: SuspensionReason } | { kind: 'closed' };

export interface Plan {
  code: string;
  priceCents: bigint;
}

export interface CustomerProps {
  id: string;
  tenantId: string;
  /** Legacy CUST_ID. Kept as the external identifier until callers move to `id`. */
  legacyId: number;
  name: string;
  email: Email | null;
  document: TaxDocument | null;
  status: CustomerStatus;
  /** Null when the legacy registration date was missing or not a calendar date. */
  registeredOn: LocalDate | null;
  city: string | null;
  state: string | null;
  plan: Plan | null;
}

/**
 * Customer aggregate. Legacy codes (A/B/S/C/X) never appear here: the anti-corruption layer
 * maps them to an explicit status with a reason.
 */
export class Customer {
  private constructor(private props: CustomerProps) {}

  static create(props: CustomerProps): Customer {
    const name = props.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new InvalidValueError('name', 'must have 1..200 characters');
    }
    if (props.state !== null && !/^[A-Z]{2}$/.test(props.state)) {
      throw new InvalidValueError('state', 'must be a two-letter UF');
    }
    if (!Number.isInteger(props.legacyId) || props.legacyId <= 0) {
      throw new InvalidValueError('legacyId', 'must be a positive integer');
    }
    return new Customer({ ...props, name });
  }

  get snapshot(): Readonly<CustomerProps> {
    return { ...this.props };
  }

  suspend(reason: SuspensionReason): void {
    if (this.props.status.kind === 'closed') {
      throw new InvalidTransitionError('customer', 'closed', 'suspended');
    }
    this.props.status = { kind: 'suspended', reason };
  }

  reactivate(): void {
    if (this.props.status.kind !== 'suspended') {
      throw new InvalidTransitionError('customer', this.props.status.kind, 'active');
    }
    this.props.status = { kind: 'active' };
  }

  close(): void {
    this.props.status = { kind: 'closed' };
  }

  update(
    changes: Partial<
      Pick<CustomerProps, 'name' | 'email' | 'document' | 'city' | 'state' | 'plan'>
    >,
  ): void {
    const next = Customer.create({ ...this.props, ...changes });
    this.props = next.props;
  }
}
