import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Kysely } from 'kysely';
import type mssql from 'mssql';
import type { Logger } from 'pino';
import { translateCustomer, translateInvoice } from '../acl/inbound';
import { customerFromRow, invoiceFromRow } from '../billing/persistence/mappers';
import type { CustomerProps } from '../billing/domain/customer';
import type { InvoiceProps } from '../billing/domain/invoice';
import type { LegacyCustomerRow, LegacyInvoiceRow } from '../legacy/contract';
import type { Database } from '../shared/database/schema';
import { emitMetrics, type MetricWriter } from '../shared/observability/metrics';
import type { StreamName } from './change-tracking';

type Canonical = Record<string, string | number | boolean | null>;

export interface PartitionMismatch {
  stream: StreamName;
  tenant: string;
  bucket: number;
  legacyCount: number;
  modernCount: number;
  missingInModern: number[];
  missingInLegacy: number[];
  different: number[];
}

export interface ParityReport {
  partitions: number;
  rowsCompared: number;
  /** Legacy rows that are expected to be absent in modern (ACL rejections, orphans). */
  excluded: number;
  mismatches: PartitionMismatch[];
}

const customerCanonical = (c: Readonly<CustomerProps>, deleted: boolean): Canonical => ({
  legacyId: c.legacyId,
  tenant: c.tenantId,
  name: c.name,
  email: c.email,
  document: c.document ? `${c.document.kind}:${c.document.digits}` : null,
  status: c.status.kind === 'suspended' ? `suspended:${c.status.reason}` : c.status.kind,
  registeredOn: c.registeredOn,
  city: c.city,
  state: c.state,
  plan: c.plan ? `${c.plan.code}:${c.plan.priceCents}` : null,
  deleted,
});

const invoiceCanonical = (i: Readonly<InvoiceProps>): Canonical => ({
  legacyId: i.legacyId,
  tenant: i.tenantId,
  customerId: i.customerId,
  period: i.period,
  dueDate: i.dueDate,
  amountCents: i.amountCents.toString(),
  status:
    i.status.kind === 'paid'
      ? `paid:${i.status.paidOn ?? '?'}`
      : i.status.kind === 'void'
        ? `void:${i.status.reason}`
        : 'open',
  notes: i.notes,
});

const SQL: Record<StreamName, { pk: string; select: string }> = {
  customers: {
    pk: 'CUST_ID',
    select: `SELECT CUST_ID, CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF,
                    PLAN_CD, PLAN_PRICE
               FROM dbo.TBL_CUST WHERE CUST_ID BETWEEN @lo AND @hi`,
  },
  invoices: {
    pk: 'INV_ID',
    select: `SELECT i.INV_ID, i.CUST_ID, i.CO_CODE, i.CUST_NAME, i.REF_MONTH, i.DUE_DT, i.AMT,
                    i.INV_STAT, i.PAY_DT, i.NOTES,
                    CASE WHEN EXISTS (SELECT 1 FROM dbo.TBL_CUST c WHERE c.CUST_ID = i.CUST_ID)
                         THEN 1 ELSE 0 END AS HAS_CUSTOMER
               FROM dbo.TBL_INV i WHERE i.INV_ID BETWEEN @lo AND @hi`,
  },
};

/**
 * Data-parity checker: row counts and SHA-256 checksums per partition (tenant × legacy-id
 * bucket), computed over the *translated* canonical form on both sides, so "equal" means
 * "what the ACL would produce from legacy is what PostgreSQL holds". Mismatching partitions
 * are drilled down to row ids and re-checked once after a delay to filter out in-flight
 * replication lag.
 */
export class ParityChecker {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly legacy: mssql.ConnectionPool,
    private readonly logger: Logger,
    private readonly options: {
      bucketSize: number;
      recheckDelayMs: number;
      metrics?: MetricWriter;
    },
  ) {}

  async run(streams: readonly StreamName[] = ['customers', 'invoices']): Promise<ParityReport> {
    const report: ParityReport = { partitions: 0, rowsCompared: 0, excluded: 0, mismatches: [] };
    for (const stream of streams) {
      const maxId = await this.maxId(stream);
      for (let bucket = 0; bucket * this.options.bucketSize <= maxId; bucket += 1) {
        const result = await this.checkBucket(stream, bucket);
        report.partitions += result.partitions;
        report.rowsCompared += result.rows;
        report.excluded += result.excluded;
        report.mismatches.push(...result.mismatches);
      }
    }

    if (report.mismatches.length > 0 && this.options.recheckDelayMs > 0) {
      await sleep(this.options.recheckDelayMs);
      const confirmed: PartitionMismatch[] = [];
      for (const mismatch of report.mismatches) {
        const again = await this.checkBucket(mismatch.stream, mismatch.bucket);
        confirmed.push(...again.mismatches.filter((m) => m.tenant === mismatch.tenant));
      }
      report.mismatches = confirmed;
    }

    emitMetrics(
      {
        ParityPartitions: { value: report.partitions, unit: 'Count' },
        ParityMismatchedPartitions: { value: report.mismatches.length, unit: 'Count' },
        ParityRowsCompared: { value: report.rowsCompared, unit: 'Count' },
      },
      {},
      this.options.metrics,
    );
    this.logger.info(
      {
        partitions: report.partitions,
        rows: report.rowsCompared,
        excluded: report.excluded,
        mismatched: report.mismatches.map((m) => `${m.stream}/${m.tenant}/${m.bucket}`),
      },
      'parity check finished',
    );
    return report;
  }

  private async maxId(stream: StreamName): Promise<number> {
    const legacy = await this.legacy
      .request()
      .query<{ v: number | null }>(
        `SELECT MAX(${SQL[stream].pk}) AS v FROM ${stream === 'customers' ? 'dbo.TBL_CUST' : 'dbo.TBL_INV'}`,
      );
    const modern = await this.db
      .selectFrom(stream)
      .select((eb) => eb.fn.max('legacy_id').as('v'))
      .executeTakeFirst();
    return Math.max(legacy.recordset[0]?.v ?? 0, Number(modern?.v ?? 0));
  }

  private async checkBucket(stream: StreamName, bucket: number) {
    const lo = bucket * this.options.bucketSize;
    const hi = lo + this.options.bucketSize - 1;
    const { rows: legacyRows, excluded } = await this.legacyCanonical(stream, lo, hi);
    const modernRows = await this.modernCanonical(stream, lo, hi);

    const tenants = new Set([...legacyRows.keys(), ...modernRows.keys()]);
    const mismatches: PartitionMismatch[] = [];
    let rows = 0;
    for (const tenant of tenants) {
      const left = legacyRows.get(tenant) ?? new Map<number, string>();
      const right = modernRows.get(tenant) ?? new Map<number, string>();
      rows += Math.max(left.size, right.size);
      if (left.size === right.size && checksum(left) === checksum(right)) continue;
      mismatches.push({
        stream,
        tenant,
        bucket,
        legacyCount: left.size,
        modernCount: right.size,
        missingInModern: [...left.keys()].filter((id) => !right.has(id)),
        missingInLegacy: [...right.keys()].filter((id) => !left.has(id)),
        different: [...left.keys()].filter((id) => right.has(id) && right.get(id) !== left.get(id)),
      });
    }
    return { partitions: tenants.size, rows, excluded, mismatches };
  }

  /** tenant → (legacy id → canonical JSON) for the rows modern is expected to hold. */
  private async legacyCanonical(stream: StreamName, lo: number, hi: number) {
    const result = await this.legacy
      .request()
      .input('lo', lo)
      .input('hi', hi)
      .query<Record<string, unknown>>(SQL[stream].select);
    const byTenant = new Map<string, Map<number, string>>();
    let excluded = 0;
    for (const record of result.recordset) {
      let entry: { tenant: string; id: number; value: Canonical } | null = null;
      try {
        if (stream === 'customers') {
          const t = translateCustomer(record as unknown as LegacyCustomerRow);
          const c = t.customer.snapshot;
          entry = { tenant: c.tenantId, id: c.legacyId, value: customerCanonical(c, t.deleted) };
        } else if (record.HAS_CUSTOMER === 1) {
          const i = translateInvoice(record as unknown as LegacyInvoiceRow).invoice.snapshot;
          entry = { tenant: i.tenantId, id: i.legacyId, value: invoiceCanonical(i) };
        }
      } catch {
        entry = null;
      }
      if (!entry) {
        excluded += 1;
        continue;
      }
      addRow(byTenant, entry.tenant, entry.id, entry.value);
    }
    return { rows: byTenant, excluded };
  }

  private async modernCanonical(stream: StreamName, lo: number, hi: number) {
    const byTenant = new Map<string, Map<number, string>>();
    if (stream === 'customers') {
      const rows = await this.db
        .selectFrom('customers')
        .selectAll()
        .where('legacy_id', '>=', lo)
        .where('legacy_id', '<=', hi)
        .execute();
      for (const row of rows) {
        const c = customerFromRow(row).snapshot;
        addRow(byTenant, c.tenantId, c.legacyId, customerCanonical(c, row.deleted_at !== null));
      }
    } else {
      const rows = await this.db
        .selectFrom('invoices')
        .selectAll()
        .where('legacy_id', '>=', lo)
        .where('legacy_id', '<=', hi)
        .execute();
      for (const row of rows) {
        const i = invoiceFromRow(row).snapshot;
        addRow(byTenant, i.tenantId, i.legacyId, invoiceCanonical(i));
      }
    }
    return byTenant;
  }
}

function addRow(
  byTenant: Map<string, Map<number, string>>,
  tenant: string,
  id: number,
  value: Canonical,
): void {
  const rows = byTenant.get(tenant) ?? new Map<number, string>();
  rows.set(id, JSON.stringify(value));
  byTenant.set(tenant, rows);
}

/** Order-independent checksum of a partition: SHA-256 over rows sorted by legacy id. */
export function checksum(rows: Map<number, string>): string {
  const hash = createHash('sha256');
  for (const id of [...rows.keys()].sort((a, b) => a - b)) hash.update(`${id}\t${rows.get(id)}\n`);
  return hash.digest('hex');
}
