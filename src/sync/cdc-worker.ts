import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../shared/database/schema';
import { emitMetrics, type MetricWriter } from '../shared/observability/metrics';
import { maxVersion, planBatch } from './batching';
import { type Change, type ChangeTrackingSource, type StreamName } from './change-tracking';
import { lockCheckpoint, writeCheckpoint } from './checkpoints';
import { type ProjectionStats, Projector } from './projector';

/** Customers first: invoices reference them (orphans are detected against PostgreSQL). */
export const STREAMS: readonly StreamName[] = ['customers', 'invoices'];

export const cdcStream = (stream: StreamName) => `cdc:${stream}`;

export interface CdcHooks {
  /** Test seam: runs after the batch is applied and before the PostgreSQL commit. */
  beforeCommit?: (stream: StreamName, changes: Change[]) => Promise<void> | void;
}

export interface PassResult {
  stream: StreamName;
  read: number;
  stats: ProjectionStats;
  checkpoint: bigint;
  /** True when the batch was full and more changes are likely waiting. */
  more: boolean;
}

export class MissingCheckpointError extends Error {
  constructor(stream: StreamName) {
    super(`no checkpoint for ${cdcStream(stream)}: run the backfill first`);
    this.name = 'MissingCheckpointError';
  }
}

/**
 * Change Tracking → PostgreSQL. Each pass, per stream:
 *   1. lock the checkpoint row (single active worker per stream),
 *   2. read net changes after the checkpoint in a snapshot (bounded batch, never splitting a version),
 *   3. project them through the ACL and advance the checkpoint in the same transaction.
 * A crash anywhere before commit leaves the checkpoint untouched; the batch is re-read and
 * re-applied idempotently.
 */
export class CdcWorker {
  private readonly projector = new Projector();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly source: ChangeTrackingSource,
    private readonly logger: Logger,
    private readonly options: { batchSize: number; hooks?: CdcHooks; metrics?: MetricWriter },
  ) {}

  async runPass(): Promise<PassResult[]> {
    const results: PassResult[] = [];
    for (const stream of STREAMS) results.push(await this.syncStream(stream));
    return results;
  }

  /** Runs passes until a pass finds no full batch, i.e. the replica is caught up. */
  async drain(maxPasses = 1_000): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const results = await this.runPass();
      if (!results.some((result) => result.more)) return;
    }
  }

  async syncStream(stream: StreamName): Promise<PassResult> {
    const started = Date.now();
    const result = await this.db.transaction().execute(async (trx) => {
      const checkpoint = await lockCheckpoint(trx, cdcStream(stream));
      if (checkpoint === null) throw new MissingCheckpointError(stream);

      const window = await this.source.readChanges(stream, checkpoint, {
        limit: this.options.batchSize,
      });
      let plan = planBatch(window.changes, this.options.batchSize);
      if (plan.kind === 'single-version-overflow') {
        const whole = await this.source.readChanges(stream, checkpoint, {
          maxVersion: plan.version,
        });
        plan = { kind: 'complete', items: whole.changes };
      }
      const changes = plan.items;
      const full = window.changes.length >= this.options.batchSize;

      const stats = await this.projector.project(trx, stream, changes);
      // Nothing new: jump to the version observed in the snapshot only when it is safe,
      // i.e. the read was not truncated.
      const next = full ? maxVersion(changes, checkpoint) : window.currentVersion;
      await this.options.hooks?.beforeCommit?.(stream, changes);
      if (next !== checkpoint) await writeCheckpoint(trx, cdcStream(stream), next);
      return { stream, read: changes.length, stats, checkpoint: next, more: full };
    });

    const lag = await this.source.lagSeconds(result.checkpoint);
    emitMetrics(
      {
        SyncChangesApplied: {
          value: result.stats.applied + result.stats.tombstoned,
          unit: 'Count',
        },
        SyncDeadLettered: { value: result.stats.deadLettered, unit: 'Count' },
        SyncEchoesSkipped: { value: result.stats.echoesSkipped, unit: 'Count' },
        ReplicationLagSeconds: { value: lag, unit: 'Seconds' },
        SyncPassDuration: { value: Date.now() - started, unit: 'Milliseconds' },
      },
      { Stream: stream },
      this.options.metrics,
    );
    if (result.read > 0) {
      this.logger.info({ ...result, checkpoint: result.checkpoint.toString(), lag }, 'cdc pass');
    }
    return result;
  }
}
