# 2. Replicate legacy data with SQL Server Change Tracking (AWS DMS as production option)

- Status: Accepted
- Date: 2026-09-07

## Context

PostgreSQL must hold a continuously updated copy of legacy customers and invoices so that the new service can serve reads and so we can compare both sides. Requirements:

- Initial load of every existing row, then incremental changes, with no gap and no double counting at the seam.
- Idempotent apply and resumable after a crash at any point.
- Low overhead on the legacy primary (it still serves all production traffic).
- Rows go through the anti-corruption layer on the way in (legacy codes → domain enums).

Options considered:

| Option | Pros | Cons |
|---|---|---|
| Triggers writing to an outbox table in SQL Server | Full control | More triggers on an already trigger-heavy schema; adds write latency to every legacy transaction |
| `LAST_UPD` timestamp polling | Trivial | Misses deletes; `LAST_UPD` is maintained by a trigger that bulk jobs bypass; clock-based cursor loses rows committed out of order |
| SQL Server **CDC** (`cdc.fn_cdc_get_all_changes_*`) | Full change history incl. before-images | Needs SQL Server Agent (on RDS: `msdb.dbo.rds_cdc_enable_db`); capture job adds log-reader load; more moving parts than we need |
| SQL Server **Change Tracking** + polling worker | Synchronous, lightweight (net changes + PK only), works on RDS without the Agent, versions are a monotonic cursor | No before-image (we read the current row), retention-bound: a worker down longer than retention must re-backfill |
| **AWS DMS** (full load + CDC, SQL Server → Aurora PostgreSQL) | Managed, monitored, handles full load + CDC seam | Transformations limited to rename/filter; our ACL (status codes, date parsing, document normalization) would run as a second hop; harder to test locally |

## Decision

**Change Tracking + an in-house sync worker** for this migration:

- `ALTER DATABASE ... SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON)` and `ENABLE CHANGE_TRACKING` on `TBL_CUST` and `TBL_INV`.
- The worker reads `CHANGETABLE(CHANGES t, @checkpoint)` in batches ordered by `SYS_CHANGE_VERSION`, translates rows through the ACL and upserts into PostgreSQL **in the same PostgreSQL transaction that advances the checkpoint**. A crash before commit replays the batch; a crash after commit resumes from the new checkpoint.
- Upserts are guarded by `source_version` (`WHERE target.source_version < excluded.source_version`), so replays and out-of-order applies are no-ops.
- Batches never cut through a version: if the batch is full, trailing rows sharing the last version are dropped and re-read next time (one legacy transaction = one version, possibly many rows).
- Backfill captures `CHANGE_TRACKING_CURRENT_VERSION()` **before** reading the first row, stamps every row with that version and stores it as the CDC starting checkpoint. Changes made during the backfill have higher versions and are applied afterwards: same seam technique DMS uses ("full load + cached changes").
- If the checkpoint falls below `CHANGE_TRACKING_MIN_VALID_VERSION`, the worker stops and alarms instead of silently skipping changes; recovery is a re-backfill (runbook).

**AWS DMS remains the recommended production option** for teams that do not need transformations in flight, or for tables outside the billing scope (e.g. audit history). In that design DMS lands raw rows into a `legacy_raw` schema in Aurora and the same ACL code runs as a projection from there; the checkpoint/idempotency rules in this ADR still apply.

## Consequences

- The legacy primary pays only the Change Tracking cost (an internal side table per tracked table, written synchronously). On RDS this does not need SQL Server Agent.
- Deletes are captured (operation `D`, row no longer joinable) and become tombstones in PostgreSQL.
- We only see the latest state of a row, not every intermediate value. Acceptable for a read model; not acceptable as an audit trail (out of scope).
- Retention is a hard operational limit: replication lag alarm at 15 minutes, page at 1 hour, retention 3 days (see [runbook](../runbook.md)).
