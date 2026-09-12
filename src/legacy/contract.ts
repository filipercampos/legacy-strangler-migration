/**
 * The public HTTP contract of the legacy billing API. Around a dozen internal callers depend
 * on it, quirks included, so the gateway preserves it byte-for-byte in meaning while traffic
 * moves to the modern service (whose compat endpoints emit the same shape through the ACL).
 */

/** Raw TBL_CUST row as returned by the stored procedures. */
export interface LegacyCustomerRow {
  CUST_ID: number;
  CO_CODE: string;
  CUST_NAME: string | null;
  EMAIL: string | null;
  DOC_NUM: string | null;
  CUST_STAT: string;
  DT_REG: string | null;
  CITY: string | null;
  UF: string | null;
  PLAN_CD: string | null;
  PLAN_PRICE: number | null;
}

/** Raw TBL_INV row as returned by the stored procedures. */
export interface LegacyInvoiceRow {
  INV_ID: number;
  CUST_ID: number;
  CO_CODE: string;
  CUST_NAME: string | null;
  REF_MONTH: string;
  DUE_DT: string;
  AMT: number;
  INV_STAT: number;
  PAY_DT: string | null;
  NOTES: string | null;
}

export interface LegacyCustomerDto {
  CustId: number;
  CoCode: string;
  Name: string | null;
  Email: string | null;
  Doc: string | null;
  /** A active, B blocked, S suspended, C cancelled. */
  Status: string;
  /** DD/MM/YYYY in theory; older rows hold YYYY-MM-DD or ''. */
  RegDate: string | null;
  City: string | null;
  Uf: string | null;
  Plan: string | null;
  PlanPrice: number | null;
}

export interface LegacyInvoiceDto {
  InvId: number;
  CustId: number;
  CustName: string | null;
  /** MM/YYYY */
  RefMonth: string;
  /** YYYYMMDD */
  DueDate: string;
  Amount: number;
  /** 0 open, 1 paid, 2 overdue, 7 written off, 9 cancelled. */
  Status: number;
  /** YYYYMMDD; unpaid shows as null, '' or '00000000'. */
  PaidOn: string | null;
  Notes: string | null;
}

export interface LegacyCustomerInput {
  Name: string;
  Email?: string | null;
  Doc?: string | null;
  Status?: string;
  City?: string | null;
  Uf?: string | null;
  Plan?: string | null;
  PlanPrice?: number | null;
}

export function toLegacyCustomerDto(row: LegacyCustomerRow): LegacyCustomerDto {
  return {
    CustId: row.CUST_ID,
    CoCode: row.CO_CODE,
    Name: row.CUST_NAME,
    Email: row.EMAIL,
    Doc: row.DOC_NUM,
    Status: row.CUST_STAT,
    RegDate: row.DT_REG,
    City: row.CITY,
    Uf: row.UF,
    Plan: row.PLAN_CD,
    PlanPrice: row.PLAN_PRICE,
  };
}

export function toLegacyInvoiceDto(row: LegacyInvoiceRow): LegacyInvoiceDto {
  return {
    InvId: row.INV_ID,
    CustId: row.CUST_ID,
    CustName: row.CUST_NAME,
    RefMonth: row.REF_MONTH,
    DueDate: row.DUE_DT,
    Amount: row.AMT,
    Status: row.INV_STAT,
    PaidOn: row.PAY_DT,
    Notes: row.NOTES,
  };
}

export const TENANT_HEADER = 'x-tenant-id';
