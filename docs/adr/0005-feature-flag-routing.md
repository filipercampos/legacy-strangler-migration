# 5. Feature-flag routing in a facade: sticky percentages for reads, ownership for writes

- Status: Accepted
- Date: 2026-10-06

## Context

Traffic must move from legacy to modern gradually and come back instantly. The unit of rollout matters:

- **Per route**: `GET /api/customers/:id` can be ready weeks before `GET /api/customers/:id/invoices`.
- **Per tenant**: tenants have different data quality (the `INITECH` extract has the most broken dates) and different contractual risk.
- **Per customer, sticky**: if a customer's requests alternate between systems while replication lags by a second, they see their data "go back in time". The same customer must always hit the same side for a given percentage.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| DNS / weighted target groups on the ALB | No code | Per-request random split, not sticky, not per route or tenant; rollback limited by DNS TTL / connection reuse |
| Flags inside each caller | Fine-grained | A dozen callers to change and coordinate; rollback needs every caller |
| Service mesh traffic split (App Mesh / Istio) | Platform feature | Weight-based, not keyed by customer id; App Mesh is being retired; not in the current platform |
| **Facade (gateway) with flag table, sticky hash, tenant overrides** | One place, keyed by business identity, audit trail, testable as a pure function | One more hop (~1–3 ms on the same VPC); the gateway must be highly available |
| Managed flag service (AWS AppConfig / LaunchDarkly) | UI, gradual deploy strategies | AppConfig is a good fit for the *storage* of flags (see consequences); the decision logic stays the same |

## Decision

`decide()` in [`src/gateway/flags.ts`](../../src/gateway/flags.ts), a pure function, with this precedence:

1. **Kill switch** → everything to legacy, shadow traffic off. One admin call (`POST /admin/kill-switch`), reaches every gateway task within `FLAG_CACHE_TTL_MS` (2 s).
2. **Writes** → the current **owner** of the entity for that tenant (`entity_ownership`), never a percentage and never shadowed (see [ADR 0003](0003-single-writer-per-entity.md)).
3. **Reads** → the tenant rule for the route, else the `*` rule; `bucket = sha256(tenant:customerId) mod 100`; modern if `bucket < modernPercent`. Raising the percentage only moves customers forward (monotonic), lowering it moves the most recent ones back first.
4. **Shadow** is sampled independently (`shadowPercent`) and compares against whichever side did *not* serve (ADR 0006).
5. **Unknown routes** go to legacy untouched.
6. A failed modern **read** falls back to legacy (`x-fallback: true`, `GatewayFallback` metric). A failed write is returned as an error; it is never retried on the other system.

Flags are rows in PostgreSQL (`routing_rules`, `entity_ownership`, `gateway_settings`), changed only through the admin API, each change written to `routing_audit` with the actor.

## Consequences

- Rollback of any read route is one API call and needs no deployment; the time to full effect is bounded by the cache TTL, not by DNS.
- Customer-level stickiness hides replication lag from users during canary phases; a customer only changes side when the percentage changes.
- The gateway is on the critical path of every call: it runs ≥ 2 tasks across AZs, has no state other than a 2-second cache, and degrades to "everything to legacy" if it cannot read flags at start-up (fail-safe default).
- Storing flags in AppConfig (with its deployment strategies and rollback alarms) is a drop-in change of `FlagStore`; we kept PostgreSQL to have one less moving part in the local stack and transactional audit rows.
