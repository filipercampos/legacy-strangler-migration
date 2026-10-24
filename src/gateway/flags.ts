import { createHash } from 'node:crypto';
import type { Entity, Owner } from '../shared/database/schema';
import type { RouteDef } from './routes';

export type Target = 'legacy' | 'modern';

export interface RouteRule {
  routeId: string;
  /** Tenant code or '*' for the default rule. */
  tenantId: string;
  /** Share of reads served by the modern service (sticky per customer). */
  modernPercent: number;
  /** Share of requests that also call the other side and compare (shadow read). */
  shadowPercent: number;
}

export interface FlagSnapshot {
  killSwitch: boolean;
  rules: RouteRule[];
  /** `${entity}:${tenant}` → owner; absent means legacy. */
  owners: Map<string, Owner>;
  /** Flags could not be loaded and nothing was cached: owners are unknown. */
  unavailable?: boolean;
}

export interface Decision {
  target: Target;
  shadow: boolean;
  reason: 'kill-switch' | 'write-owner' | 'percentage' | 'no-rule';
  /** 0..99 bucket of the sticky key (reads only). */
  bucket?: number;
}

export const ownerKey = (entity: Entity, tenantId: string) => `${entity}:${tenantId}`;

/**
 * Stable 0..99 bucket. Keyed by tenant + resource (customer) id, not by route, so one
 * customer sees the same side across all read routes and never flaps between systems.
 */
export function stickyBucket(tenantId: string, key: string): number {
  const digest = createHash('sha256').update(`${tenantId}:${key}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Routing decision (pure). Order of precedence:
 *  1. kill switch → legacy, no shadow (instant rollback);
 *  2. writes → the single owner of the entity for that tenant, never shadowed (ADR 0003);
 *  3. reads → tenant rule, else '*' rule; modern if bucket < modernPercent.
 */
export function decide(
  route: RouteDef,
  tenantId: string,
  stickyKey: string,
  flags: FlagSnapshot,
  random: () => number = Math.random,
): Decision {
  if (flags.killSwitch) return { target: 'legacy', shadow: false, reason: 'kill-switch' };

  if (route.kind === 'write') {
    const owner = flags.owners.get(ownerKey(route.entity, tenantId)) ?? 'legacy';
    return { target: owner, shadow: false, reason: 'write-owner' };
  }

  const rule =
    flags.rules.find((r) => r.routeId === route.id && r.tenantId === tenantId) ??
    flags.rules.find((r) => r.routeId === route.id && r.tenantId === '*');
  if (!rule) return { target: 'legacy', shadow: false, reason: 'no-rule' };

  const bucket = stickyBucket(tenantId, stickyKey);
  const target: Target = bucket < rule.modernPercent ? 'modern' : 'legacy';
  const shadow = rule.shadowPercent > 0 && random() * 100 < rule.shadowPercent;
  return { target, shadow, reason: 'percentage', bucket };
}
