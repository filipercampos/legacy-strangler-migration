import { type Kysely, sql } from 'kysely';
import mssql from 'mssql';
import type { Logger } from 'pino';
import type { LegacyCustomerDto } from '../legacy/contract';
import type { Database } from '../shared/database/schema';
import { emitMetrics, type MetricWriter } from '../shared/observability/metrics';

const MAX_ATTEMPTS = 10;

export interface ReverseSyncResult {
  synced: number;
  failed: number;
}

/**
 * Modern → legacy, only while modern owns customer writes for some tenant. Drains the
 * `reverse_sync_outbox` in id order and calls `usp_SyncCustomerFromModern`, which writes with
 * a Change Tracking context so the CDC worker recognises and skips the echo.
 *
 * Payloads are full snapshots, so replays are harmless; order matters per customer, which is
 * why this runs as a single worker (ECS desired count 1) and stops at the first failure
 * instead of skipping ahead.
 */
export class ReverseSync {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly legacy: mssql.ConnectionPool,
    private readonly logger: Logger,
    private readonly options: { batchSize: number; metrics?: MetricWriter },
  ) {}

  async runPass(): Promise<ReverseSyncResult> {
    const pending = await this.db
      .selectFrom('reverse_sync_outbox')
      .select(['id', 'legacy_id', 'payload', 'attempts'])
      .where('synced_at', 'is', null)
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('id')
      .limit(this.options.batchSize)
      .execute();

    let synced = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this.apply(item.payload as LegacyCustomerDto);
        await this.db
          .updateTable('reverse_sync_outbox')
          .set({ synced_at: sql<Date>`now()`, last_error: null })
          .where('id', '=', item.id)
          .execute();
        synced += 1;
      } catch (error) {
        failed += 1;
        await this.db
          .updateTable('reverse_sync_outbox')
          .set({ attempts: item.attempts + 1, last_error: String(error).slice(0, 1_000) })
          .where('id', '=', item.id)
          .execute();
        this.logger.error({ err: error, legacyId: item.legacy_id }, 'reverse sync failed');
        break;
      }
    }

    const backlog = await this.db
      .selectFrom('reverse_sync_outbox')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('synced_at', 'is', null)
      .executeTakeFirstOrThrow();
    emitMetrics(
      {
        ReverseSyncApplied: { value: synced, unit: 'Count' },
        ReverseSyncFailed: { value: failed, unit: 'Count' },
        ReverseSyncBacklog: { value: Number(backlog.n), unit: 'Count' },
      },
      {},
      this.options.metrics,
    );
    return { synced, failed };
  }

  private async apply(customer: LegacyCustomerDto): Promise<void> {
    await this.legacy
      .request()
      .input('CustId', mssql.Int, customer.CustId)
      .input('CoCode', mssql.NVarChar(10), customer.CoCode)
      .input('Name', mssql.NVarChar(200), customer.Name)
      .input('Email', mssql.NVarChar(200), customer.Email)
      .input('Doc', mssql.NVarChar(20), customer.Doc)
      .input('Stat', mssql.Char(1), customer.Status)
      .input('DtReg', mssql.NVarChar(10), customer.RegDate)
      .input('City', mssql.NVarChar(100), customer.City)
      .input('Uf', mssql.Char(2), customer.Uf)
      .input('PlanCd', mssql.NVarChar(20), customer.Plan)
      .input('PlanPrice', mssql.Money, customer.PlanPrice)
      .execute('dbo.usp_SyncCustomerFromModern');
  }
}
