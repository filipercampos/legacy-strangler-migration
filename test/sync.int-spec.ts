import type { Kysely } from 'kysely';
import type mssql from 'mssql';
import { modernIdFor } from '../src/acl/legacy-ids';
import type { Database } from '../src/shared/database/schema';
import { Backfill, backfillStream } from '../src/sync/backfill';
import { type CdcHooks, cdcStream, CdcWorker } from '../src/sync/cdc-worker';
import { ChangeTrackingSource } from '../src/sync/change-tracking';
import { readCheckpoint, writeCheckpoint } from '../src/sync/checkpoints';
import {
  createLegacyDatabase,
  createPgDatabase,
  discardMetrics,
  exec,
  silentLogger,
} from './support/databases';

async function scalar(pool: mssql.ConnectionPool, query: string): Promise<number> {
  const result = await pool.request().query<{ v: number }>(query);
  return Number(result.recordset[0]?.v);
}

/** Replica content without bookkeeping timestamps, for before/after comparisons. */
async function replica(db: Kysely<Database>) {
  const customers = await db
    .selectFrom('customers')
    .select(['legacy_id', 'name', 'email', 'status', 'suspension_reason', 'source_version'])
    .select((eb) => eb('deleted_at', 'is not', null).as('deleted'))
    .orderBy('legacy_id')
    .execute();
  const invoices = await db
    .selectFrom('invoices')
    .select(['legacy_id', 'status', 'paid_on', 'amount_cents', 'source_version'])
    .orderBy('legacy_id')
    .execute();
  return { customers, invoices };
}

function setup(name: string, seed: number) {
  const ctx = {} as {
    legacy: mssql.ConnectionPool;
    db: Kysely<Database>;
    source: ChangeTrackingSource;
    worker: (options?: { batchSize?: number; hooks?: CdcHooks }) => CdcWorker;
    backfill: (options?: { afterBatch?: (stream: string, key: number) => void }) => Backfill;
  };
  beforeAll(async () => {
    ctx.legacy = await createLegacyDatabase(name, seed);
    ctx.db = (await createPgDatabase(name.toLowerCase())).db;
    ctx.source = new ChangeTrackingSource(ctx.legacy);
    ctx.worker = (options = {}) =>
      new CdcWorker(ctx.db, ctx.source, silentLogger, {
        batchSize: options.batchSize ?? 50,
        hooks: options.hooks,
        metrics: discardMetrics,
      });
    ctx.backfill = (options = {}) =>
      new Backfill(ctx.db, ctx.source, silentLogger, {
        batchSize: 50,
        maxRowsPerSecond: 1_000_000,
        metrics: discardMetrics,
        afterBatch: options.afterBatch,
      });
  });
  afterAll(async () => {
    await ctx.legacy.close();
    await ctx.db.destroy();
  });
  return ctx;
}

describe('sync: backfill + CDC correctness (integration)', () => {
  const ctx = setup('SyncCorrectness', 200);

  it('backfills every row, keeps soft-deleted customers as tombstones and dead-letters orphans', async () => {
    const report = await ctx.backfill().run();

    expect(report.resumed).toBe(false);
    const customers = await ctx.db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(customers.n)).toBe(await scalar(ctx.legacy, 'SELECT COUNT(*) v FROM TBL_CUST'));
    const invoices = await ctx.db
      .selectFrom('invoices')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(invoices.n)).toBe(
      (await scalar(ctx.legacy, 'SELECT COUNT(*) v FROM TBL_INV')) - 5,
    );

    const letters = await ctx.db
      .selectFrom('sync_dead_letters')
      .select(['reason', 'legacy_id'])
      .execute();
    expect(letters).toHaveLength(5);
    expect(new Set(letters.map((letter) => letter.reason))).toEqual(new Set(['orphan_invoice']));

    expect(await readCheckpoint(ctx.db, cdcStream('customers'))).toBe(report.snapshotVersion);
    expect(await readCheckpoint(ctx.db, cdcStream('invoices'))).toBe(report.snapshotVersion);
  });

  it('applies inserts, updates, soft and hard deletes, including trigger side effects', async () => {
    const overdue = await scalar(
      ctx.legacy,
      'SELECT INV_ID v FROM TBL_INV WHERE CUST_ID = 23 AND INV_STAT = 2',
    );
    await exec(
      ctx.legacy,
      `EXEC usp_SaveCustomer @CoCode = 'ACME', @Name = 'Brand New', @Doc = '529.982.247-25';
       EXEC usp_SaveCustomer @CustId = 4, @CoCode = 'GLOBEX', @Name = 'Renamed Four', @Stat = 'A';
       EXEC usp_PayInvoice @InvId = ${overdue}, @CoCode = 'INITECH';
       UPDATE TBL_CUST SET CUST_STAT = 'X' WHERE CUST_ID = 5;
       DELETE FROM TBL_CUST WHERE CUST_ID = 6;`,
    );

    await ctx.worker().drain();

    const byLegacyId = async (id: number) =>
      ctx.db
        .selectFrom('customers')
        .selectAll()
        .where('legacy_id', '=', id)
        .executeTakeFirstOrThrow();
    expect((await byLegacyId(201)).name).toBe('Brand New');
    expect((await byLegacyId(201)).document_digits).toBe('52998224725');
    expect((await byLegacyId(4)).name).toBe('Renamed Four');
    // TRG_INV_PAID unblocked customer 23 inside the payment transaction: the change reached
    // PostgreSQL through the customers stream although nobody "updated the customer".
    expect((await byLegacyId(23)).status).toBe('active');
    expect((await byLegacyId(5)).deleted_at).not.toBeNull();
    expect((await byLegacyId(6)).deleted_at).not.toBeNull();

    const paid = await ctx.db
      .selectFrom('invoices')
      .selectAll()
      .where('legacy_id', '=', overdue)
      .executeTakeFirstOrThrow();
    expect(paid.status).toBe('paid');
    // Payment date stamped by the trigger (YYYYMMDD of "today" in the container).
    expect(paid.paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(paid.customer_id).toBe(modernIdFor('customer', 23));
  });

  it('never splits one legacy transaction across batches', async () => {
    // One UPDATE = one Change Tracking version for ~200 rows; batch size 7 must not lose any.
    await exec(
      ctx.legacy,
      `UPDATE TBL_INV SET NOTES = N'bulk-touched' WHERE REF_MONTH = N'06/2026'`,
    );
    const touched = await scalar(
      ctx.legacy,
      `SELECT COUNT(*) v FROM TBL_INV WHERE REF_MONTH = N'06/2026'`,
    );

    await ctx.worker({ batchSize: 7 }).drain();

    const applied = await ctx.db
      .selectFrom('invoices')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('notes', '=', 'bulk-touched')
      .executeTakeFirstOrThrow();
    expect(Number(applied.n)).toBe(touched);
    expect(await readCheckpoint(ctx.db, cdcStream('invoices'))).toBe(
      await ctx.source.currentVersion(),
    );
  });

  it('is idempotent: replaying everything since the snapshot changes nothing', async () => {
    const before = await replica(ctx.db);
    const snapshot = (await readCheckpoint(ctx.db, 'backfill:snapshot-version')) ?? 0n;
    await writeCheckpoint(ctx.db, cdcStream('customers'), snapshot);
    await writeCheckpoint(ctx.db, cdcStream('invoices'), snapshot);

    await ctx.worker({ batchSize: 13 }).drain();

    expect(await replica(ctx.db)).toEqual(before);
  });
});

describe('sync: crash and resume (integration)', () => {
  const ctx = setup('SyncResume', 200);

  it('resumes a crashed backfill from its checkpoint and still captures changes made meanwhile', async () => {
    let batches = 0;
    await expect(
      ctx
        .backfill({
          afterBatch: () => {
            batches += 1;
            if (batches === 3) throw new Error('simulated crash');
          },
        })
        .run(),
    ).rejects.toThrow('simulated crash');
    expect(await readCheckpoint(ctx.db, backfillStream('customers'))).toBe(150n);

    // While the backfill is down: change a row already copied and one not copied yet.
    await exec(
      ctx.legacy,
      `UPDATE TBL_CUST SET CUST_NAME = N'Changed After Copy' WHERE CUST_ID = 2;
       UPDATE TBL_CUST SET CUST_NAME = N'Changed Before Copy' WHERE CUST_ID = 190;`,
    );

    const report = await ctx.backfill().run();
    expect(report.resumed).toBe(true);
    expect(report.rows.customers).toBe(50);

    await ctx.worker().drain();
    const names = await ctx.db
      .selectFrom('customers')
      .select(['legacy_id', 'name'])
      .where('legacy_id', 'in', [2, 190])
      .orderBy('legacy_id')
      .execute();
    expect(names).toEqual([
      { legacy_id: 2, name: 'Changed After Copy' },
      { legacy_id: 190, name: 'Changed Before Copy' },
    ]);
  });

  it('rolls back a batch that crashes before commit and converges on restart', async () => {
    await exec(ctx.legacy, `UPDATE TBL_CUST SET CITY = N'Recife', UF = 'PE' WHERE CUST_ID <= 30`);
    const checkpoint = await readCheckpoint(ctx.db, cdcStream('customers'));

    const crashing = ctx.worker({
      hooks: {
        beforeCommit: (stream) => {
          if (stream === 'customers') throw new Error('killed before commit');
        },
      },
    });
    await expect(crashing.runPass()).rejects.toThrow('killed before commit');

    // Nothing from the failed batch is visible and the checkpoint did not move.
    expect(await readCheckpoint(ctx.db, cdcStream('customers'))).toBe(checkpoint);
    const partial = await ctx.db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('city', '=', 'Recife')
      .executeTakeFirstOrThrow();
    expect(Number(partial.n)).toBe(0);

    await ctx.worker().drain();
    const converged = await ctx.db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('city', '=', 'Recife')
      .where('state', '=', 'PE')
      .executeTakeFirstOrThrow();
    expect(Number(converged.n)).toBe(30);
  });
});
