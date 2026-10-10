import { canonicalBody } from './canonical';

export interface Difference {
  path: string;
  legacy: unknown;
  modern: unknown;
}

export interface Observed {
  status: number;
  body: string;
}

/** Structural diff; arrays are compared by position (both sides order by legacy id). */
export function deepDiff(legacy: unknown, modern: unknown, path = '$'): Difference[] {
  if (Object.is(legacy, modern)) return [];
  if (Array.isArray(legacy) && Array.isArray(modern)) {
    const diffs: Difference[] = [];
    const length = Math.max(legacy.length, modern.length);
    for (let i = 0; i < length; i += 1)
      diffs.push(...deepDiff(legacy[i], modern[i], `${path}[${i}]`));
    return diffs;
  }
  if (isObject(legacy) && isObject(modern)) {
    const keys = new Set([...Object.keys(legacy), ...Object.keys(modern)]);
    const diffs: Difference[] = [];
    for (const key of [...keys].sort())
      diffs.push(...deepDiff(legacy[key], modern[key], `${path}.${key}`));
    return diffs;
  }
  return [{ path, legacy, modern }];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compares two responses of the same request. Status codes must match; bodies are compared
 * in canonical form only when both sides succeeded (error bodies are not part of the
 * contract callers rely on).
 */
export function compareResponses(
  routeId: string,
  legacy: Observed,
  modern: Observed,
): Difference[] {
  if (legacy.status !== modern.status) {
    return [{ path: '$status', legacy: legacy.status, modern: modern.status }];
  }
  if (legacy.status >= 300) return [];
  try {
    return deepDiff(
      canonicalBody(routeId, JSON.parse(legacy.body)),
      canonicalBody(routeId, JSON.parse(modern.body)),
    );
  } catch {
    return legacy.body === modern.body
      ? []
      : [{ path: '$body', legacy: 'unparseable', modern: 'unparseable' }];
  }
}
