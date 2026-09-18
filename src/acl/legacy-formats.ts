import {
  type BillingPeriod,
  type LocalDate,
  billingPeriod,
  isLocalDate,
  localDate,
} from '../billing/domain/values';

/** Result of a lenient parse: the value (if any) plus a data-quality issue to record. */
export interface Parsed<T> {
  value: T | null;
  issue?: string;
}

/** DT_REG: 'DD/MM/YYYY', older rows 'YYYY-MM-DD', sometimes '' or impossible dates. */
export function parseRegistrationDate(raw: string | null): Parsed<LocalDate> {
  const value = raw?.trim() ?? '';
  if (value === '') return { value: null, issue: 'registration_date_missing' };
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : value;
  if (isLocalDate(iso)) return { value: localDate(iso) };
  return { value: null, issue: `registration_date_invalid:${value}` };
}

/** DUE_DT / PAY_DT: 'YYYYMMDD'; unpaid is NULL, '' or '00000000'. */
export function parseCompactDate(raw: string | null): Parsed<LocalDate> {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '00000000') return { value: null };
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  if (isLocalDate(iso)) return { value: localDate(iso) };
  return { value: null, issue: `compact_date_invalid:${value}` };
}

/** REF_MONTH: 'MM/YYYY'. */
export function parseReferenceMonth(raw: string): BillingPeriod | null {
  const match = /^(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  try {
    return billingPeriod(`${match[2]}-${match[1]}`);
  } catch {
    return null;
  }
}

/** MONEY (4 decimals, surfaced by the driver as a JS number) → integer cents. */
export function moneyToCents(value: number): Parsed<bigint> {
  const scaled = Math.round(value * 10_000);
  const cents = Math.round(scaled / 100);
  return scaled % 100 === 0
    ? { value: BigInt(cents) }
    : { value: BigInt(cents), issue: 'amount_rounded' };
}

export function centsToMoney(value: bigint): number {
  return Number(value) / 100;
}

export function toLegacyDmy(date: LocalDate): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

export function toLegacyCompact(date: LocalDate): string {
  return date.replaceAll('-', '');
}

export function toLegacyReferenceMonth(period: BillingPeriod): string {
  return `${period.slice(5, 7)}/${period.slice(0, 4)}`;
}
