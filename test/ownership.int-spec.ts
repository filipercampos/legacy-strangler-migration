import type { Kysely } from 'kysely';
import type mssql from 'mssql';
import { Clock } from '../src/billing/clock';
import { CustomerWriteService } from '../src/billing/compat/customer-writes.service';
import { NotEntityOwnerError } from '../src/billing/domain/errors';
import type { Database } from '../src/shared/database/schema';
import { Backfill } from '../src/sync/backfill';
import { CdcWorker } from '../src/sync/cdc-worker';
import { ChangeTrackingSource } from '../src/sync/change-tracking';
import { ReverseSync } from '../src/sync/reverse-sync';
import {
  createLegacyDatabase,
  createPgDatabase,
  discardMetrics,
  exec,
  silentLogger,
} from './support/databases';

describe('single writer + reverse sync (integration)', () => {
  let legacy: mssql.ConnectionPool;
  let db: Kysely<Database>;
  let cdc: CdcWorker;
  let reverse: ReverseSync;
  let writes: CustomerWriteService;

  const legacyRow = async (id: number) =>
    (
      await legacy
        .request()
        .query<{ CUST_NAME: string; CUST_STAT: string; LAST_UPD_BY: string }>(
          `SELECT CUST_NAME, CUST_STAT, LAST_UPD_BY FROM TBL_CUST WHERE CUST_ID = ${id}`,
        )
    ).recordset[0];

  beforeAll(async () => {
    legacy = await createLegacyDatabase('Ownership', 60);
    db = (await createPgDatabase('ownership')).db;
    const source = new ChangeTrackingSource(legacy);
    await new Backfill(db, source, silentLogger, {
      batchSize: 100,
      maxRowsPerSecond: 1_000_000,
      metrics: discardMetrics,
    }).run();
    cdc = new CdcWorker(db, source, silentLogger, { batchSize: 100, metrics: discardMetrics });
    reverse = new ReverseSync(db, legacy, silentLogger, { batchSize: 50, metrics: discardMetrics });
    writes = new CustomerWriteService(db, new Clock());
    await db
      .insertInto('entity_ownership')
      .values({ entity: 'customers', tenant_id: 'ACME', owner: 'modern', changed_by: 'test' })
      .execute();
  });

  afterAll(async () => {
    await legacy.close();
    await db.destroy();
  });

  it('rejects modern writes for a tenant that legacy still owns', async () => {
    await expect(writes.save('GLOBEX', null, { Name: 'Nope' })).rejects.toBeInstanceOf(
      NotEntityOwnerError,
    );
  });

  it('writes on the modern side and replicates them back to legacy without echoing', async () => {
    const created = await writes.save('ACME', null, {
      Name: 'Born Modern',
      Email: 'born@example.com',
      Doc: '52998224725',
      Plan: 'PRO',
      PlanPrice: 99.9,
    });
    expect(created.CustId).toBe(50_000_000);
    const updated = await writes.save('ACME', 3, { Name: 'Updated In Modern', Status: 'S' });
    expect(updated.Status).toBe('S');

    expect(await reverse.runPass()).toEqual({ synced: 2, failed: 0 });

    expect(await legacyRow(50_000_000)).toMatchObject({
      CUST_NAME: 'Born Modern',
      LAST_UPD_BY: 'modern-sync',
    });
    expect(await legacyRow(3)).toMatchObject({ CUST_NAME: 'Updated In Modern', CUST_STAT: 'S' });
    const invoiceNames = await legacy
      .request()
      .query<{ CUST_NAME: string }>('SELECT DISTINCT CUST_NAME FROM TBL_INV WHERE CUST_ID = 3');
    expect(invoiceNames.recordset).toEqual([{ CUST_NAME: 'Updated In Modern' }]);

    // The explicit id must not drag the legacy IDENTITY into the modern range.
    const inserted = await legacy
      .request()
      .query<{ CUST_ID: number }>(
        `EXEC usp_SaveCustomer @CoCode = 'GLOBEX', @Name = 'Legacy Still Inserts'`,
      );
    expect(inserted.recordset[0]?.CUST_ID).toBe(61);

    // CDC sees the reverse-sync writes but recognises the Change Tracking context.
    const results = await cdc.runPass();
    const customers = results.find((r) => r.stream === 'customers');
    expect(customers?.stats.echoesSkipped).toBe(2);
    const letters = await db
      .selectFrom('sync_dead_letters')
      .select('reason')
      .where('reason', '=', 'write_to_non_owner')
      .execute();
    expect(letters).toHaveLength(0);
    const globex = await db
      .selectFrom('customers')
      .select('name')
      .where('legacy_id', '=', 61)
      .executeTakeFirst();
    expect(globex?.name).toBe('Legacy Still Inserts');
  });

  it('detects and quarantines a legacy write to an entity modern owns (split brain)', async () => {
    await exec(legacy, `UPDATE TBL_CUST SET CUST_NAME = N'Sneaky Batch Job' WHERE CUST_ID = 6`);
    await cdc.drain();

    const letter = await db
      .selectFrom('sync_dead_letters')
      .select(['reason', 'legacy_id'])
      .where('reason', '=', 'write_to_non_owner')
      .executeTakeFirstOrThrow();
    expect(letter.legacy_id).toBe(6);
    const modern = await db
      .selectFrom('customers')
      .select('name')
      .where('legacy_id', '=', 6)
      .executeTakeFirstOrThrow();
    expect(modern.name).toBe('Customer 6');
  });
});
