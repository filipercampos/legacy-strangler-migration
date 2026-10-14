# 3. Single writer per entity and tenant; reverse sync only after an ownership flip

- Status: Accepted
- Date: 2026-10-13

## Context

During the transition both systems hold customer and invoice data. If both accept writes for the same record, they diverge on every partial failure (legacy committed, modern timed out) and on every concurrent update, and there is no distributed transaction between SQL Server and PostgreSQL to fix that. Dual writes from the gateway or from callers would also make "rollback" ambiguous: which copy is right?

Options considered:

| Option | Pros | Cons |
|---|---|---|
| Dual write (gateway writes to both) | Both always "up to date" | No atomicity; ordering races; failure handling is a distributed-transaction problem in disguise |
| Bi-directional sync, both writable | Callers can hit either side | Conflict resolution for every field; loops; the hardest kind of bug to reproduce |
| **One writer per entity per tenant**, the other side is a read replica fed by sync | Every record has one source of truth at any moment; conflicts impossible by construction | Ownership flips need a short write freeze per tenant; rollback after a flip needs the reverse sync |

## Decision

- `entity_ownership(entity, tenant_id, owner)` is the single source of truth for who may write. Missing row = legacy.
- **Gateway**: write routes go to the owner only, regardless of read percentages, and are never shadowed ([ADR 0005](0005-feature-flag-routing.md)).
- **Modern service**: write endpoints read the ownership row `FOR SHARE` inside the write transaction and return `409 not_entity_owner` if modern is not the owner. The flip (an `UPDATE` of that row) therefore waits for in-flight modern writes, and no write can straddle it.
- **Legacy → modern (CDC)**: changes for an entity/tenant owned by modern are **not applied**; they are dead-lettered as `write_to_non_owner` and alarmed. That is how hidden writers are found (SQL Agent jobs, ad-hoc scripts, and triggers such as `TRG_INV_PAID`, which updates `TBL_CUST` when an invoice is paid).
- **Modern → legacy (reverse sync)**: while modern owns an entity, every modern write enqueues the full legacy representation in `reverse_sync_outbox` (same transaction). A single worker applies it through `usp_SyncCustomerFromModern`, which:
  - writes with `WITH CHANGE_TRACKING_CONTEXT('modern-sync')` so the CDC worker skips the echo instead of looping,
  - sets `SESSION_CONTEXT('sync_origin')` so the legacy triggers stand down (their own UPDATEs would not carry the context),
  - inserts modern-created customers with their pre-allocated id from the modern range (≥ 50,000,000) and restores the IDENTITY seed under a table lock, so legacy inserts stay in the legacy range.
- Legacy stays complete during the whole transition, which is what keeps **rollback after an ownership flip** possible: flip ownership back to legacy, stop the reverse sync after its backlog is empty, resume CDC.

## Consequences

- No conflict resolution code exists, because conflicts cannot happen; the cost moved to the flip procedure (runbook: freeze writes for the tenant, drain CDC, flip, unfreeze), which takes seconds per tenant.
- Hidden legacy writers surface as dead letters before they corrupt anything, but the write they made is lost from the modern point of view until someone acts. The `write_to_non_owner` alarm is paging.
- Reverse sync is the one place we write into legacy. It is kept deliberately small (customers only, full snapshots, single ordered worker) and is deleted with the legacy system.
- Invoices stay legacy-owned in this phase: the payment flow touches customers through `TRG_INV_PAID`, so that rule must move to the modern service before invoice ownership can flip (risk R-03).
