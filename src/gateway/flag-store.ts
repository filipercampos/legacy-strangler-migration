import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { GatewayEnv } from '../shared/config/env';
import type { Database, Entity, Owner } from '../shared/database/schema';
import { DB, ENV } from '../shared/nest/tokens';
import { type FlagSnapshot, ownerKey, type RouteRule } from './flags';

/**
 * Routing flags live in PostgreSQL and are cached per gateway task for FLAG_CACHE_TTL_MS
 * (default 2 s). That TTL is the upper bound for a rollback to reach every task; the task
 * that receives the admin call applies it immediately.
 */
@Injectable()
export class FlagStore {
  private cached: { snapshot: FlagSnapshot; at: number } | undefined;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(ENV) private readonly env: GatewayEnv,
  ) {}

  async snapshot(): Promise<FlagSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.env.FLAG_CACHE_TTL_MS)
      return this.cached.snapshot;
    const [settings, rules, owners] = await Promise.all([
      this.db.selectFrom('gateway_settings').select('kill_switch').executeTakeFirst(),
      this.db.selectFrom('routing_rules').selectAll().execute(),
      this.db.selectFrom('entity_ownership').selectAll().execute(),
    ]);
    const snapshot: FlagSnapshot = {
      killSwitch: settings?.kill_switch ?? false,
      rules: rules.map((rule) => ({
        routeId: rule.route_id,
        tenantId: rule.tenant_id,
        modernPercent: rule.modern_percent,
        shadowPercent: rule.shadow_percent,
      })),
      owners: new Map(owners.map((row) => [ownerKey(row.entity, row.tenant_id), row.owner])),
    };
    this.cached = { snapshot, at: now };
    return snapshot;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async upsertRule(rule: RouteRule, actor: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('routing_rules')
        .values({
          route_id: rule.routeId,
          tenant_id: rule.tenantId,
          modern_percent: rule.modernPercent,
          shadow_percent: rule.shadowPercent,
          updated_by: actor,
        })
        .onConflict((oc) =>
          oc.columns(['route_id', 'tenant_id']).doUpdateSet({
            modern_percent: rule.modernPercent,
            shadow_percent: rule.shadowPercent,
            updated_by: actor,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
      await trx
        .insertInto('routing_audit')
        .values({ actor, action: 'rule.upsert', detail: JSON.stringify(rule) })
        .execute();
    });
    this.invalidate();
  }

  async setKillSwitch(on: boolean, actor: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('gateway_settings')
        .set({ kill_switch: on, updated_by: actor, updated_at: sql<Date>`now()` })
        .execute();
      await trx
        .insertInto('routing_audit')
        .values({ actor, action: on ? 'kill-switch.on' : 'kill-switch.off', detail: '{}' })
        .execute();
    });
    this.invalidate();
  }

  async setOwner(entity: Entity, tenantId: string, owner: Owner, actor: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('entity_ownership')
        .values({ entity, tenant_id: tenantId, owner, changed_by: actor })
        .onConflict((oc) =>
          oc
            .columns(['entity', 'tenant_id'])
            .doUpdateSet({ owner, changed_by: actor, changed_at: sql<Date>`now()` }),
        )
        .execute();
      await trx
        .insertInto('routing_audit')
        .values({
          actor,
          action: 'ownership.set',
          detail: JSON.stringify({ entity, tenantId, owner }),
        })
        .execute();
    });
    this.invalidate();
  }
}
