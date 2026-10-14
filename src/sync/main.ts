import { shutdownTracing, startTracing } from '../shared/observability/tracing';
startTracing('sync-worker');

import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { connectLegacyDb, legacyDbOptionsFromEnv } from '../legacy/db/connection';
import { loadEnv, syncEnvSchema } from '../shared/config/env';
import { createDatabase } from '../shared/database/database';
import { Backfill } from './backfill';
import { CdcWorker } from './cdc-worker';
import { ChangeTrackingSource, RetentionExceededError } from './change-tracking';
import { ReverseSync } from './reverse-sync';

/**
 * Sync worker entrypoint (ECS service in AWS). Usage:
 *   node dist/sync/main.js cdc        continuous Change Tracking → PostgreSQL
 */
async function main(command: string | undefined): Promise<void> {
  const env = loadEnv(syncEnvSchema);
  const logger = pino({ level: env.LOG_LEVEL, base: { service: 'sync-worker', command } });
  const db = createDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: 4,
    applicationName: `sync-${command ?? 'unknown'}`,
  });
  const legacy = await connectLegacyDb({
    ...legacyDbOptionsFromEnv(env),
    appName: 'sync-worker',
    poolMax: 4,
  });
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());

  try {
    switch (command) {
      case 'cdc': {
        const worker = new CdcWorker(db, new ChangeTrackingSource(legacy), logger, {
          batchSize: env.SYNC_BATCH_SIZE,
        });
        let failures = 0;
        while (!abort.signal.aborted) {
          try {
            const results = await worker.runPass();
            failures = 0;
            if (results.some((result) => result.more)) continue;
            await sleep(env.SYNC_POLL_INTERVAL_MS, undefined, { signal: abort.signal }).catch(
              () => undefined,
            );
          } catch (error) {
            // Retention exceeded cannot be fixed by retrying: exit and let the alarm page.
            if (error instanceof RetentionExceededError) throw error;
            failures += 1;
            const backoff = Math.min(30_000, 500 * 2 ** failures);
            logger.error({ err: error, backoff }, 'cdc pass failed');
            await sleep(backoff, undefined, { signal: abort.signal }).catch(() => undefined);
          }
        }
        break;
      }
      case 'backfill': {
        const report = await new Backfill(db, new ChangeTrackingSource(legacy), logger, {
          batchSize: env.BACKFILL_BATCH_SIZE,
          maxRowsPerSecond: env.BACKFILL_MAX_ROWS_PER_SECOND,
        }).run();
        logger.info(
          { ...report, snapshotVersion: report.snapshotVersion.toString() },
          'backfill report',
        );
        break;
      }
      case 'reverse': {
        const reverse = new ReverseSync(db, legacy, logger, { batchSize: env.SYNC_BATCH_SIZE });
        while (!abort.signal.aborted) {
          const result = await reverse.runPass();
          if (result.synced > 0 && result.failed === 0) continue;
          await sleep(env.SYNC_POLL_INTERVAL_MS, undefined, { signal: abort.signal }).catch(
            () => undefined,
          );
        }
        break;
      }
      default:
        throw new Error(`unknown command "${command ?? ''}"`);
    }
  } finally {
    await legacy.close();
    await db.destroy();
    await shutdownTracing();
  }
}

main(process.argv[2]).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
