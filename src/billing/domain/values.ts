import { InvalidValueError } from './errors';

/** ISO calendar date (YYYY-MM-DD) without time zone: due dates and payment days are local. */
export type LocalDate = string & { readonly __brand: 'LocalDate' };

export function localDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new InvalidValueError('date', `"${value}" is not YYYY-MM-DD`);
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new InvalidValueError('date', `"${value}" is not a calendar date`);
  }
  return value as LocalDate;
}

export function isLocalDate(value: string): boolean {
  try {
    localDate(value);
    return true;
  } catch {
    return false;
  }
}

/** Billing period (YYYY-MM). */
export type BillingPeriod = string & { readonly __brand: 'BillingPeriod' };

export function billingPeriod(value: string): BillingPeriod {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new InvalidValueError('period', `"${value}" is not YYYY-MM`);
  }
  return value as BillingPeriod;
}

export type TaxDocumentKind = 'cpf' | 'cnpj';

/** Brazilian tax id: CPF (individuals, 11 digits) or CNPJ (companies, 14 digits). */
export interface TaxDocument {
  readonly kind: TaxDocumentKind;
  readonly digits: string;
}

export function taxDocument(raw: string): TaxDocument {
  const digits = raw.replace(/[.\-/\s]/g, '');
  if (!/^\d+$/.test(digits)) throw new InvalidValueError('document', 'must contain digits only');
  if (/^(\d)\1+$/.test(digits)) throw new InvalidValueError('document', 'repeated digits');
  if (digits.length === 11) return { kind: 'cpf', digits };
  if (digits.length === 14) return { kind: 'cnpj', digits };
  throw new InvalidValueError('document', `unexpected length ${digits.length}`);
}

export function formatTaxDocument(document: TaxDocument): string {
  const d = document.digits;
  return document.kind === 'cpf'
    ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
    : `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export type Email = string & { readonly __brand: 'Email' };

export function email(raw: string): Email {
  const value = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 200) {
    throw new InvalidValueError('email', 'malformed');
  }
  return value as Email;
}

/** Money in integer cents. The legacy MONEY type has 4 decimals; billing never uses them. */
export function cents(value: bigint): bigint {
  if (value < 0n) throw new InvalidValueError('amount', 'must not be negative');
  return value;
}
