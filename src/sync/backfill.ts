import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../shared/database/schema';
import { emitMetrics, type MetricWriter } from '../shared/observability/metrics';
import { cdcStream, STREAMS } from './cdc-worker';
import type { Change, ChangeTrackingSource, StreamName } from './change-tracking';
import { lockCheckpoint, readCheckpoint, writeCheckpoint } from './checkpoints';
import { Projector } from './projector';
import { RateLimiter } from './rate-limiter';

export const SNAPSHOT_STREAM = 'backfill:snapshot-version';
export const backfillStream = (stream: StreamName) => `backfill:${stream}`;

export interface BackfillOptions {
  batchSize: number;
  maxRowsPerSecond: number;
  metrics?: MetricWriter;
  /** Test seam: called after each committed batch; throwing simulates a crash. */
  afterBatch?: (stream: StreamName, lastKey: number) => Promise<void> | void;
}

export interface BackfillReport {
  snapshotVersion: bigint;
  rows: Record<StreamName, number>;
  resumed: boolean;
}

/**
 * Initial load, resumable and throttled.
 *
 * Seam with CDC: the Change Tracking version is captured *before* the first row is read and
 * stamped on every backfilled row. CDC then starts from that version, so anything changed
 * during the backfill is applied afterwards with a higher version; the `source_version`
 * guard keeps an older snapshot row from overwriting a newer CDC change. (This is the same
 * "full load + cached changes" approach AWS DMS uses.)
 *
 * Resume: the last key per table is checkpointed in the same transaction as the batch.
 */
export class Backfill {
  private readonly projector = new Projector();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly source: ChangeTrackingSource,
    private readonly logger: Logger,
    private readonly options: BackfillOptions,
  ) {}

  async run(): Promise<BackfillReport> {
    let snapshotVersion = await readCheckpoint(this.db, SNAPSHOT_STREAM);
    const resumed = snapshotVersion !== null;
    if (snapshotVersion === null) {
      snapshotVersion = await this.source.currentVersion();
      await this.db.transaction().execute(async (trx) => {
        await writeCheckpoint(trx, SNAPSHOT_STREAM, snapshotVersion as bigint);
        for (const stream of STREAMS) await writeCheckpoint(trx, backfillStream(stream), 0n);
      });
    }
    this.logger.info({ snapshotVersion: snapshotVersion.toString(), resumed }, 'backfill start');

    const limiter = new RateLimiter(this.options.maxRowsPerSecond);
    const rows: Record<StreamName, number> = { customers: 0, invoices: 0 };
    for (const stream of STREAMS) {
      rows[stream] = await this.copyTable(stream, snapshotVersion, limiter);
    }

    // Hand over to CDC exactly at the snapshot version (only if CDC has not started yet).
    await this.db.transaction().execute(async (trx) => {
      for (const stream of STREAMS) {
        const existing = await lockCheckpoint(trx, cdcStream(stream));
        if (existing === null) await writeCheckpoint(trx, cdcStream(stream), snapshotVersion);
      }
    });
    this.logger.info({ rows }, 'backfill complete');
    return { snapshotVersion, rows, resumed };
  }

  private async copyTable(
    stream: StreamName,
    version: bigint,
    limiter: RateLimiter,
  ): Promise<number> {
    let copied = 0;
    for (;;) {
      const lastKey = Number((await readCheckpoint(this.db, backfillStream(stream))) ?? 0n);
      const page = await this.source.readPage(stream, lastKey, this.options.batchSize);
      if (page.length === 0) return copied;

      const throttled = await limiter.acquire(page.length);
      const changes: Change[] = page.map((row) => ({
        version,
        operation: 'I',
        context: null,
        key: this.source.keyOf(stream, row),
        row,
      }));
      const nextKey = changes[changes.length - 1]?.key ?? lastKey;

      const stats = await this.db.transaction().execute(async (trx) => {
        const result = await this.projector.project(trx, stream, changes);
        await writeCheckpoint(trx, backfillStream(stream), BigInt(nextKey));
        return result;
      });
      copied += page.length;
      emitMetrics(
        {
          BackfillRows: { value: page.length, unit: 'Count' },
          BackfillDeadLettered: { value: stats.deadLettered, unit: 'Count' },
          BackfillThrottled: { value: throttled, unit: 'Milliseconds' },
        },
        { Stream: stream },
        this.options.metrics,
      );
      await this.options.afterBatch?.(stream, nextKey);
    }
  }
}
