import type { Entity } from '../shared/database/schema';

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface RouteDef {
  id: string;
  method: HttpMethod;
  pattern: RegExp;
  entity: Entity;
  kind: 'read' | 'write';
}

export interface MatchedRoute {
  route: RouteDef;
  /** Customer (or invoice) id from the path; the sticky key for percentage rollout. */
  resourceId: string | undefined;
}

/**
 * The legacy public contract, route by route. Anything not listed here is forwarded to the
 * legacy app untouched (the strangler's default), so an unknown endpoint can never break.
 */
export const ROUTES: readonly RouteDef[] = [
  {
    id: 'customers.list',
    method: 'GET',
    pattern: /^\/api\/customers$/,
    entity: 'customers',
    kind: 'read',
  },
  {
    id: 'customers.get',
    method: 'GET',
    pattern: /^\/api\/customers\/(\d+)$/,
    entity: 'customers',
    kind: 'read',
  },
  {
    id: 'customers.create',
    method: 'POST',
    pattern: /^\/api\/customers$/,
    entity: 'customers',
    kind: 'write',
  },
  {
    id: 'customers.update',
    method: 'PUT',
    pattern: /^\/api\/customers\/(\d+)$/,
    entity: 'customers',
    kind: 'write',
  },
  {
    id: 'invoices.list',
    method: 'GET',
    pattern: /^\/api\/customers\/(\d+)\/invoices$/,
    entity: 'invoices',
    kind: 'read',
  },
  {
    id: 'invoices.pay',
    method: 'POST',
    pattern: /^\/api\/invoices\/(\d+)\/pay$/,
    entity: 'invoices',
    kind: 'write',
  },
];

export function matchRoute(method: string, path: string): MatchedRoute | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) return { route, resourceId: match[1] };
  }
  return undefined;
}
