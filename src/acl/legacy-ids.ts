import { createHash } from 'node:crypto';

export type LegacyEntity = 'customer' | 'invoice';

/**
 * Deterministic UUID (RFC 4122 v5 layout over SHA-256) for a legacy row. The same legacy id
 * always yields the same modern id, so backfill, CDC replays and the compat API never need a
 * lookup table to agree on identity.
 */
export function modernIdFor(entity: LegacyEntity, legacyId: number): string {
  const bytes = createHash('sha256').update(`legacy-billing:${entity}:${legacyId}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Customers created by the modern service while it owns writes get legacy-compatible ids from
 * a disjoint range, so the reverse sync can insert them into TBL_CUST without colliding with
 * the legacy IDENTITY sequence (see ADR 0003).
 */
export const MODERN_LEGACY_ID_START = 50_000_000;
