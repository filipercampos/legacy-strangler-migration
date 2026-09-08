# 1. Strangler Fig migration instead of a big-bang rewrite

- Status: Accepted
- Date: 2026-09-07

## Context

The customer/billing system is a 15-year-old application on SQL Server (RDS SQL Server in production). Business logic lives in stored procedures and triggers; the schema is denormalized (customer name copied into invoices, dates stored as `nvarchar`, status as magic codes). Every change is slow and risky, and the licence cost of SQL Server is a recurring line item.

The target is a NestJS service on Aurora PostgreSQL with an explicit domain model. Billing is revenue-critical: an outage or a wrong invoice amount is a customer-facing incident, and roughly a dozen internal consumers call the legacy HTTP API.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| Big-bang rewrite + weekend cutover | One switch, no coexistence code | All risk lands on one night; undiscovered legacy behaviour (triggers, overdue batch, orphan rows) shows up in production; rollback means restoring the old DB and losing every write since cutover |
| Rewrite + dual writes from callers | No sync infrastructure | Every caller changes; two systems drift on partial failures (no distributed transaction); impossible to prove parity |
| Lift-and-shift SQL Server to Babelfish | Little code change | Keeps the stored-procedure design and its smells; Babelfish T-SQL coverage gaps in triggers and `CHANGETABLE` |
| **Strangler Fig**: facade in front, new service grows route by route, data replicated by CDC | Each step small and reversible; parity measurable before switching traffic; callers unchanged | Coexistence costs: facade, sync worker, ACL and verification jobs must be built and later removed |

## Decision

Strangler Fig:

1. A **routing facade** (the gateway) owns the public contract. Callers point at it once; after that, every move between legacy and modern is a flag change, not a deployment (see [ADR 0005](0005-feature-flag-routing.md)).
2. **Legacy stays the system of record** until an entity is formally handed over. Data reaches PostgreSQL by CDC ([ADR 0002](0002-cdc-with-sql-server-change-tracking.md)); there are no dual writes ([ADR 0003](0003-single-writer-per-entity.md)).
3. The new domain is protected by an **anti-corruption layer** ([ADR 0004](0004-anti-corruption-layer.md)): legacy codes and formats are translated at the boundary and never leak into the model.
4. Reads move first (shadow → canary → 100 %), writes move per entity and per tenant after parity is proven ([ADR 0006](0006-verification-shadow-reads-and-parity.md), [cutover plan](../cutover-plan.md)).

## Consequences

- Every phase has an instant rollback: flip the route back to legacy. Only the write-ownership flip needs reverse sync to stay reversible, and that window is bounded.
- We pay for temporary code (gateway rules, sync worker, compat API). It is isolated in `src/gateway`, `src/sync` and `src/billing/compat` so it can be deleted at decommission.
- The migration is longer in calendar time than a rewrite would look on paper. Accepted: the risk is spread over many small, measurable steps.
