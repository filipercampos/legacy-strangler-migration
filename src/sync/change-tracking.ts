import sql from 'mssql';
import type { LegacyCustomerRow, LegacyInvoiceRow } from '../legacy/contract';

export type StreamName = 'customers' | 'invoices';

interface TableDef {
  table: string;
  pk: string;
  columns: string;
}

const TABLES: Record<StreamName, TableDef> = {
  customers: {
    table: 'dbo.TBL_CUST',
    pk: 'CUST_ID',
    columns:
      't.CUST_ID, t.CO_CODE, t.CUST_NAME, t.EMAIL, t.DOC_NUM, t.CUST_STAT, t.DT_REG, t.CITY, t.UF, t.PLAN_CD, t.PLAN_PRICE',
  },
  invoices: {
    table: 'dbo.TBL_INV',
    pk: 'INV_ID',
    columns:
      't.INV_ID, t.CUST_ID, t.CO_CODE, t.CUST_NAME, t.REF_MONTH, t.DUE_DT, t.AMT, t.INV_STAT, t.PAY_DT, t.NOTES',
  },
};

export type RowFor<S extends StreamName> = S extends 'customers'
  ? LegacyCustomerRow
  : LegacyInvoiceRow;

export interface Change<S extends StreamName = StreamName> {
  version: bigint;
  operation: 'I' | 'U' | 'D';
  /** CHANGE_TRACKING_CONTEXT of the last change, e.g. 'modern-sync' for reverse-sync echoes. */
  context: string | null;
  key: number;
  /** Current row (null when the row no longer exists). */
  row: RowFor<S> | null;
}

export interface ChangeWindow<S extends StreamName = StreamName> {
  changes: Change<S>[];
  /** CHANGE_TRACKING_CURRENT_VERSION() in the same snapshot. */
  currentVersion: bigint;
  minValidVersion: bigint;
}

export class RetentionExceededError extends Error {
  constructor(stream: StreamName, checkpoint: bigint, minValid: bigint) {
    super(
      `${stream}: checkpoint ${checkpoint} is older than CHANGE_TRACKING_MIN_VALID_VERSION ${minValid}; re-backfill required`,
    );
    this.name = 'RetentionExceededError';
  }
}

export const SYNC_CONTEXT = 'modern-sync';

/**
 * Reads net changes from SQL Server Change Tracking. Everything happens in one SNAPSHOT
 * transaction, so the min-valid check, the CHANGETABLE read, the joined base rows and the
 * current version are mutually consistent (the pattern recommended by Microsoft).
 */
export class ChangeTrackingSource {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async readChanges<S extends StreamName>(
    stream: S,
    since: bigint,
    options: { limit?: number; maxVersion?: bigint },
  ): Promise<ChangeWindow<S>> {
    const def = TABLES[stream];
    const tx = new sql.Transaction(this.pool);
    await tx.begin(sql.ISOLATION_LEVEL.SNAPSHOT);
    try {
      const meta = await new sql.Request(tx)
        .input('table', sql.NVarChar(128), def.table)
        .query<{ current: string; minValid: string | null }>(
          `SELECT CAST(CHANGE_TRACKING_CURRENT_VERSION() AS NVARCHAR(30)) AS [current],
                  CAST(CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(@table)) AS NVARCHAR(30)) AS minValid`,
        );
      const currentVersion = BigInt(meta.recordset[0]?.current ?? '0');
      const minValidVersion = BigInt(meta.recordset[0]?.minValid ?? '0');
      if (since < minValidVersion) throw new RetentionExceededError(stream, since, minValidVersion);

      const upTo = options.maxVersion ?? currentVersion;
      const top = options.limit !== undefined ? `TOP (${Math.trunc(options.limit)})` : '';
      const result = await new sql.Request(tx)
        .input('since', sql.BigInt, since.toString())
        .input('upTo', sql.BigInt, upTo.toString())
        .query<Record<string, unknown>>(
          `SELECT ${top}
                  CAST(ct.SYS_CHANGE_VERSION AS NVARCHAR(30)) AS __version,
                  ct.SYS_CHANGE_OPERATION AS __operation,
                  CAST(ct.SYS_CHANGE_CONTEXT AS VARCHAR(128)) AS __context,
                  ct.${def.pk} AS __key,
                  ${def.columns}
             FROM CHANGETABLE(CHANGES ${def.table}, @since) AS ct
             LEFT JOIN ${def.table} AS t ON t.${def.pk} = ct.${def.pk}
            WHERE ct.SYS_CHANGE_VERSION <= @upTo
            ORDER BY ct.SYS_CHANGE_VERSION, ct.${def.pk}`,
        );
      await tx.commit();

      const changes = result.recordset.map((record): Change<S> => {
        const { __version, __operation, __context, __key, ...row } = record;
        const exists = row[def.pk] !== null && row[def.pk] !== undefined;
        return {
          version: BigInt(String(__version)),
          operation: String(__operation).trim() as Change['operation'],
          context: typeof __context === 'string' ? __context : null,
          key: Number(__key),
          row: exists ? (row as unknown as RowFor<S>) : null,
        };
      });
      return { changes, currentVersion, minValidVersion };
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }

  async currentVersion(): Promise<bigint> {
    const result = await this.pool
      .request()
      .query<{ v: string }>('SELECT CAST(CHANGE_TRACKING_CURRENT_VERSION() AS NVARCHAR(30)) AS v');
    return BigInt(result.recordset[0]?.v ?? '0');
  }

  /**
   * Replication lag in seconds: age of the oldest committed change after the checkpoint
   * (0 when caught up). sys.dm_tran_commit_table maps CT versions to commit times.
   */
  async lagSeconds(checkpoint: bigint): Promise<number> {
    const result = await this.pool
      .request()
      .input('checkpoint', sql.BigInt, checkpoint.toString())
      .query<{ lag: number | null }>(
        `SELECT DATEDIFF(SECOND, MIN(commit_time), SYSUTCDATETIME()) AS lag
           FROM sys.dm_tran_commit_table WHERE commit_ts > @checkpoint`,
      );
    return Math.max(0, result.recordset[0]?.lag ?? 0);
  }
}
