import { decide, type FlagSnapshot, ownerKey, stickyBucket } from './flags';
import { matchRoute } from './routes';

const read = matchRoute('GET', '/api/customers/42')!.route;
const write = matchRoute('PUT', '/api/customers/42')!.route;

const flags = (overrides: Partial<FlagSnapshot> = {}): FlagSnapshot => ({
  killSwitch: false,
  rules: [],
  owners: new Map(),
  ...overrides,
});

describe('matchRoute', () => {
  it('extracts the sticky resource id and leaves unknown paths unmatched', () => {
    expect(matchRoute('GET', '/api/customers/42/invoices')).toMatchObject({
      route: { id: 'invoices.list' },
      resourceId: '42',
    });
    expect(matchRoute('DELETE', '/api/customers/42')).toBeUndefined();
    expect(matchRoute('GET', '/api/reports/aging')).toBeUndefined();
  });
});

describe('decide', () => {
  it('routes everything to legacy when there is no rule', () => {
    expect(decide(read, 'ACME', '42', flags())).toEqual({
      target: 'legacy',
      shadow: false,
      reason: 'no-rule',
    });
  });

  it('is sticky: the same customer always lands on the same side', () => {
    const snapshot = flags({
      rules: [{ routeId: 'customers.get', tenantId: '*', modernPercent: 50, shadowPercent: 0 }],
    });
    const first = decide(read, 'ACME', '42', snapshot).target;
    for (let i = 0; i < 20; i += 1) expect(decide(read, 'ACME', '42', snapshot).target).toBe(first);
  });

  it('serves roughly the configured share of customers from modern', () => {
    const snapshot = flags({
      rules: [{ routeId: 'customers.get', tenantId: '*', modernPercent: 25, shadowPercent: 0 }],
    });
    let modern = 0;
    for (let id = 1; id <= 4_000; id += 1) {
      if (decide(read, 'ACME', String(id), snapshot).target === 'modern') modern += 1;
    }
    expect(modern / 4_000).toBeGreaterThan(0.22);
    expect(modern / 4_000).toBeLessThan(0.28);
  });

  it('only moves customers forward when the percentage grows (monotonic rollout)', () => {
    const at = (percent: number) =>
      flags({
        rules: [
          { routeId: 'customers.get', tenantId: '*', modernPercent: percent, shadowPercent: 0 },
        ],
      });
    for (let id = 1; id <= 500; id += 1) {
      if (decide(read, 'ACME', String(id), at(10)).target === 'modern') {
        expect(decide(read, 'ACME', String(id), at(30)).target).toBe('modern');
      }
    }
  });

  it('lets a tenant rule override the default rule', () => {
    const snapshot = flags({
      rules: [
        { routeId: 'customers.get', tenantId: '*', modernPercent: 100, shadowPercent: 0 },
        { routeId: 'customers.get', tenantId: 'GLOBEX', modernPercent: 0, shadowPercent: 0 },
      ],
    });
    expect(decide(read, 'ACME', '42', snapshot).target).toBe('modern');
    expect(decide(read, 'GLOBEX', '42', snapshot).target).toBe('legacy');
  });

  it('samples shadow traffic independently of the target', () => {
    const snapshot = flags({
      rules: [{ routeId: 'customers.get', tenantId: '*', modernPercent: 0, shadowPercent: 10 }],
    });
    expect(decide(read, 'ACME', '42', snapshot, () => 0.05).shadow).toBe(true);
    expect(decide(read, 'ACME', '42', snapshot, () => 0.5).shadow).toBe(false);
  });

  it('sends writes to the single owner and never shadows them', () => {
    const owned = flags({
      rules: [{ routeId: 'customers.update', tenantId: '*', modernPercent: 0, shadowPercent: 100 }],
      owners: new Map([[ownerKey('customers', 'ACME'), 'modern']]),
    });
    expect(decide(write, 'ACME', '42', owned)).toEqual({
      target: 'modern',
      shadow: false,
      reason: 'write-owner',
    });
    expect(decide(write, 'GLOBEX', '42', owned).target).toBe('legacy');
  });

  it('kill switch wins over everything', () => {
    const snapshot = flags({
      killSwitch: true,
      rules: [{ routeId: 'customers.get', tenantId: '*', modernPercent: 100, shadowPercent: 100 }],
      owners: new Map([[ownerKey('customers', 'ACME'), 'modern']]),
    });
    expect(decide(read, 'ACME', '42', snapshot).target).toBe('legacy');
    expect(decide(write, 'ACME', '42', snapshot)).toMatchObject({
      target: 'legacy',
      shadow: false,
    });
  });

  it('buckets are stable across releases', () => {
    // Pinned: changing the hash input would silently move customers between systems.
    expect(stickyBucket('ACME', '42')).toBe(43);
  });
});
