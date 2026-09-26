/**
 * One legacy transaction = one Change Tracking version, possibly many rows. A batch read with
 * TOP(n) can stop in the middle of a version; checkpointing that version would skip the rows
 * of the same version that did not fit. So a full batch gives back its trailing version.
 */
export type BatchPlan<T> =
  | { kind: 'complete'; items: T[] }
  /** Every row in the batch shares one version: re-read that version without a limit. */
  | { kind: 'single-version-overflow'; version: bigint };

export function planBatch<T extends { version: bigint }>(items: T[], limit: number): BatchPlan<T> {
  if (items.length < limit) return { kind: 'complete', items };
  const last = items[items.length - 1];
  if (!last) return { kind: 'complete', items };
  const kept = items.filter((item) => item.version < last.version);
  if (kept.length === 0) return { kind: 'single-version-overflow', version: last.version };
  return { kind: 'complete', items: kept };
}

/** Highest version in a non-empty batch, which becomes the new checkpoint. */
export function maxVersion(items: { version: bigint }[], fallback: bigint): bigint {
  return items.reduce((max, item) => (item.version > max ? item.version : max), fallback);
}
