import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import type mssql from 'mssql';
import request from 'supertest';
import { createLegacyApp } from '../src/legacy/app';
import { stickyBucket } from '../src/gateway/flags';
import { ShadowRunner } from '../src/gateway/shadow/shadow-runner';
import type { Database } from '../src/shared/database/schema';
import { Backfill } from '../src/sync/backfill';
import { CdcWorker } from '../src/sync/cdc-worker';
import { ChangeTrackingSource } from '../src/sync/change-tracking';
import { ParityChecker } from '../src/sync/parity';
import { ReverseSync } from '../src/sync/reverse-sync';
import {
  createLegacyDatabase,
  createPgDatabase,
  discardMetrics,
  exec,
  silentLogger,
} from './support/databases';

const ADMIN = { 'x-admin-token': 'integration-admin-token', 'x-admin-actor': 'it-suite' };
const TENANTS = ['ACME', 'GLOBEX', 'INITECH'] as const;
/** Seed rule: customer k belongs to TENANTS[k % 3]. */
const tenantOf = (id: number) => TENANTS[id % 3] as string;

describe('gateway, shadow reads and parity (integration)', () => {
  let legacyPool: mssql.ConnectionPool;
  let db: Kysely<Database>;
  let legacyServer: Server;
  let billing: INestApplication;
  let gateway: INestApplication;
  let cdc: CdcWorker;
  let parity: ParityChecker;
  let reverse: ReverseSync;

  const http = () => request(gateway.getHttpServer() as Server);
  const setRule = (routeId: string, tenantId: string, modernPercent: number, shadowPercent = 0) =>
    http()
      .put('/admin/rules')
      .set(ADMIN)
      .send({ routeId, tenantId, modernPercent, shadowPercent })
      .expect(200);
  const getCustomer = (id: number) =>
    http().get(`/api/customers/${id}`).set('x-tenant-id', tenantOf(id));

  beforeAll(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true); // EMF lines
    legacyPool = await createLegacyDatabase('Gateway', 150);
    const pg = await createPgDatabase('gateway');
    db = pg.db;
    const source = new ChangeTrackingSource(legacyPool);
    await new Backfill(db, source, silentLogger, {
      batchSize: 200,
      maxRowsPerSecond: 1_000_000,
      metrics: discardMetrics,
    }).run();
    cdc = new CdcWorker(db, source, silentLogger, { batchSize: 200, metrics: discardMetrics });
    parity = new ParityChecker(db, legacyPool, silentLogger, {
      bucketSize: 50,
      recheckDelayMs: 0,
      metrics: discardMetrics,
    });
    reverse = new ReverseSync(db, legacyPool, silentLogger, {
      batchSize: 50,
      metrics: discardMetrics,
    });

    legacyServer = createLegacyApp(legacyPool, 'silent').listen(0);
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: pg.url,
      ADMIN_TOKEN: ADMIN['x-admin-token'],
      FLAG_CACHE_TTL_MS: '0',
    });

    // Modules read their env when imported, so import them after the env is in place.
    const { BillingModule } = await import('../src/billing/billing.module');
    billing = (
      await Test.createTestingModule({ imports: [BillingModule] }).compile()
    ).createNestApplication({
      logger: false,
    });
    await billing.listen(0, '127.0.0.1');

    process.env.LEGACY_BASE_URL = `http://127.0.0.1:${(legacyServer.address() as AddressInfo).port}`;
    const billingPort = ((billing.getHttpServer() as Server).address() as AddressInfo).port;
    process.env.MODERN_BASE_URL = `http://127.0.0.1:${billingPort}`;
    const { GatewayModule } = await import('../src/gateway/gateway.module');
    gateway = (
      await Test.createTestingModule({ imports: [GatewayModule] }).compile()
    ).createNestApplication({
      logger: false,
    });
    await gateway.init();
  });

  afterAll(async () => {
    await gateway.close();
    await billing.close().catch(() => undefined);
    await new Promise((resolve) => legacyServer.close(resolve));
    await legacyPool.close();
    await db.destroy();
    jest.restoreAllMocks();
  });

  it('starts from full parity after backfill (orphans excluded, not reported)', async () => {
    const report = await parity.run();
    expect(report.mismatches).toEqual([]);
    expect(report.excluded).toBe(5);
    expect(report.rowsCompared).toBe(150 + 600);
  });

  it('protects the admin API', async () => {
    await http().get('/admin/flags').expect(401);
    await http().get('/admin/flags').set({ 'x-admin-token': ADMIN['x-admin-token'] }).expect(400);
    await http()
      .put('/admin/rules')
      .set(ADMIN)
      .send({ routeId: 'nope', tenantId: '*', modernPercent: 1, shadowPercent: 0 })
      .expect(400);
  });

  it('routes reads by sticky percentage and honours tenant overrides', async () => {
    await setRule('customers.get', '*', 50);
    await setRule('customers.get', 'GLOBEX', 0);

    for (let id = 1; id <= 45; id += 1) {
      const tenant = tenantOf(id);
      const expected =
        tenant !== 'GLOBEX' && stickyBucket(tenant, String(id)) < 50 ? 'modern' : 'legacy';
      const first = await getCustomer(id);
      const second = await getCustomer(id);
      expect(first.headers['x-served-by']).toBe(expected);
      expect(second.headers['x-served-by']).toBe(expected);
      expect(first.status).toBe(second.status);
    }
  });

  it('rolls everything back to legacy with the kill switch, and forward again', async () => {
    await setRule('customers.get', '*', 100);
    await setRule('customers.get', 'GLOBEX', 100);
    expect((await getCustomer(1)).headers['x-served-by']).toBe('modern');

    await http().post('/admin/kill-switch').set(ADMIN).send({ on: true }).expect(201);
    for (const id of [1, 2, 3]) {
      const response = await getCustomer(id);
      expect(response.headers['x-served-by']).toBe('legacy');
      expect(response.headers['x-route-reason']).toBe('kill-switch');
    }

    await http().post('/admin/kill-switch').set(ADMIN).send({ on: false }).expect(201);
    expect((await getCustomer(1)).headers['x-served-by']).toBe('modern');
    const audit = await db
      .selectFrom('routing_audit')
      .select('action')
      .where('actor', '=', 'it-suite')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['kill-switch.on', 'kill-switch.off']),
    );
  });

  it('sends writes only to the current owner, whatever the read percentage', async () => {
    // Reads are 100 % modern, but legacy still owns writes.
    const viaLegacy = await http()
      .put('/api/customers/3')
      .set('x-tenant-id', 'ACME')
      .send({ Name: 'Written Through Legacy', Status: 'A' })
      .expect(200);
    expect(viaLegacy.headers['x-served-by']).toBe('legacy');
    await cdc.drain();

    await http()
      .put('/admin/ownership')
      .set(ADMIN)
      .send({ entity: 'customers', tenantId: 'ACME', owner: 'modern' })
      .expect(200);
    const viaModern = await http()
      .put('/api/customers/3')
      .set('x-tenant-id', 'ACME')
      .send({ Name: 'Written Through Modern', Status: 'A' })
      .expect(200);
    expect(viaModern.headers['x-served-by']).toBe('modern');
    const otherTenant = await http()
      .put('/api/customers/4')
      .set('x-tenant-id', 'GLOBEX')
      .send({ Name: 'Still Legacy', Status: 'A' })
      .expect(200);
    expect(otherTenant.headers['x-served-by']).toBe('legacy');

    await reverse.runPass();
    await cdc.drain();
    expect((await parity.run(['customers'])).mismatches).toEqual([]);
  });

  it('shadow reads find no mismatch on synced data despite all the legacy formatting', async () => {
    await setRule('customers.get', '*', 0, 100);
    await setRule('customers.get', 'GLOBEX', 0, 100);
    await setRule('invoices.list', '*', 0, 100);
    for (let id = 1; id <= 60; id += 1) {
      await getCustomer(id).expect((res) => expect(res.headers['x-served-by']).toBe('legacy'));
      await http().get(`/api/customers/${id}/invoices`).set('x-tenant-id', tenantOf(id));
    }
    await gateway.get(ShadowRunner).flush();

    const stats = (await http().get('/admin/shadow/stats').set(ADMIN).expect(200)).body as Record<
      string,
      { compared: number; mismatched: number }
    >;
    expect(stats['customers.get']).toMatchObject({ compared: 60, mismatched: 0 });
    expect(stats['invoices.list']).toMatchObject({ compared: 60, mismatched: 0 });
  });

  it('shadow reads detect a divergence, record the path and drive the mismatch rate', async () => {
    await db
      .updateTable('customers')
      .set({ plan_price_cents: 1n })
      .where('legacy_id', '=', 7)
      .execute();
    await getCustomer(7).expect(200);
    await gateway.get(ShadowRunner).flush();

    const stats = gateway.get(ShadowRunner).snapshot()['customers.get'];
    expect(stats).toMatchObject({ compared: 61, mismatched: 1 });
    expect(stats?.mismatchRate).toBeCloseTo(1 / 61);
    const sample = await db.selectFrom('shadow_mismatches').selectAll().executeTakeFirstOrThrow();
    expect(sample).toMatchObject({
      route_id: 'customers.get',
      resource_id: '7',
      served_by: 'legacy',
    });
    expect(sample.diff).toEqual([{ path: '$.PlanPrice', legacy: 9990, modern: 1 }]);
  });

  it('parity drill-down pinpoints drifted, missing and extra rows', async () => {
    // Drift on 7 (above), a legacy change that never reached modern, a row only in modern.
    await exec(legacyPool, `UPDATE TBL_INV SET AMT = 1234.56 WHERE INV_ID = 20`);
    await db.deleteFrom('invoices').where('legacy_id', '=', 21).execute();
    await db
      .insertInto('invoices')
      .values({
        id: '00000000-0000-4000-8000-00000000abcd',
        tenant_id: 'ACME',
        legacy_id: 49,
        customer_id: (
          await db
            .selectFrom('customers')
            .select('id')
            .where('legacy_id', '=', 3)
            .executeTakeFirstOrThrow()
        ).id,
        period: '2026-08',
        due_date: '2026-08-10',
        amount_cents: 100n,
        status: 'open',
        void_reason: null,
        paid_on: null,
        notes: null,
        data_issues: [],
        source_version: 1n,
      })
      .onConflict((oc) => oc.column('legacy_id').doUpdateSet({ amount_cents: 100n }))
      .execute();

    const report = await parity.run();
    const flatten = (field: 'different' | 'missingInModern' | 'missingInLegacy') =>
      report.mismatches.flatMap((m) => m[field].map((id) => `${m.stream}:${id}`)).sort();
    expect(flatten('different')).toEqual(['customers:7', 'invoices:20', 'invoices:49'].sort());
    expect(flatten('missingInModern')).toEqual(['invoices:21']);
  });

  it('falls back to legacy when the modern service is down', async () => {
    await setRule('customers.get', '*', 100);
    await billing.close();
    const response = await getCustomer(3).expect(200); // ACME: no tenant override
    expect(response.headers['x-served-by']).toBe('legacy');
    expect(response.headers['x-fallback']).toBe('true');
  });
});
