# Runbook

All admin calls go to the internal ALB from the ops VPN and need the token from the `GatewayAdminToken` secret:

```bash
A=(-H "x-admin-token: $TOKEN" -H "x-admin-actor: $USER" -H 'content-type: application/json')
```

Every change lands in `routing_audit` (actor, action, detail, timestamp).

## Emergency rollback (any read phase)

```bash
curl -X POST "${A[@]}" https://$GATEWAY/admin/kill-switch -d '{"on":true}'
```

Every route goes to legacy, shadow traffic stops, writes go to legacy **only if legacy owns them**: the kill switch does not change write ownership (see [ownership rollback](#ownership-rollback)). Effective on all gateway tasks within `FLAG_CACHE_TTL_MS` (2 s). Verify with the `GatewayRequests{Target=modern}` metric dropping to 0 and `x-served-by: legacy` on a sample request. Undo with `{"on":false}`; rules are kept, so traffic returns to the pre-incident split.

Narrower rollback of one route or tenant:

```bash
curl -X PUT "${A[@]}" https://$GATEWAY/admin/rules \
  -d '{"routeId":"invoices.list","tenantId":"GLOBEX","modernPercent":0,"shadowPercent":10}'
```

## replication-lag

**Alarm:** `ReplicationLagSeconds{Stream}` > 900 s for 15 minutes, or no data (worker not running).

1. ECS → `CdcService`: is a task running? Check logs (`/ecs/strangler-migration-<env>`, prefix `sync`) for `cdc pass failed`.
2. `RetentionExceededError` in the logs → see [retention exceeded](#retention-exceeded). Do **not** just restart.
3. Errors from PostgreSQL (`08P01`, timeouts) or SQL Server (login, deadlock victim): the worker retries with exponential backoff up to 30 s; fix the cause, no manual replay is needed (checkpoint did not move).
4. Lag growing without errors: a very large legacy transaction (one version, many rows) is being applied. `SyncPassDuration` will show it. Wait; if it exceeds 1 h, raise the task size.
5. While lag is high, shadow reads report mismatches that are only lag; do not advance any phase until lag is back under 60 s.

Check the checkpoints directly:

```sql
SELECT stream, position, now() - updated_at AS since_update FROM sync_checkpoints ORDER BY stream;
```

## retention-exceeded

The CDC checkpoint is older than `CHANGE_TRACKING_MIN_VALID_VERSION` (worker was down longer than the 3-day retention). Changes in the gap are gone from Change Tracking.

1. Kill switch on if any read route is served by modern (data may be stale).
2. Stop `CdcService`.
3. Re-backfill: delete the `backfill:*` and `cdc:*` rows from `sync_checkpoints`, run the backfill task (`node dist/sync/main.js backfill`). Existing rows are upserted in place (versioned), nothing is truncated. Hard deletes that happened in the gap are not replayed by a backfill; the parity checker lists them as `missingInLegacy`.
4. Start `CdcService`; wait for lag < 60 s; run parity; kill switch off.

## shadow-mismatch

**Alarm:** `ShadowMismatch / ShadowCompared` > 0.5 % over 15 minutes for a route.

1. Recent samples (restricted table, contains customer data):

   ```sql
   SELECT route_id, tenant_id, resource_id, served_by, diff, created_at
     FROM shadow_mismatches
    WHERE created_at > now() - interval '1 hour'
    ORDER BY created_at DESC LIMIT 50;
   ```

2. Group by `diff->0->>'path'`. One path dominating = one cause.
3. Classify: **lag** (row changed seconds before; disappears on retry and parity is green), **translation bug** (ACL/compat; fix + test), **behaviour difference** (e.g. legacy trigger nobody knew about; product decision → either implement in modern or add an accepted-difference rule to `canonical.ts` and ADR 0006).
4. If modern serves the route and the difference is user-visible: roll the route back first, investigate second.
5. Purge samples older than 14 days (scheduled): `DELETE FROM shadow_mismatches WHERE created_at < now() - interval '14 days';`

## parity-mismatch

**Alarm:** `ParityMismatchedPartitions` > 0 (after the built-in 30 s recheck), or the parity task did not report (treated as breaching).

The task log line `parity check finished` lists `stream/tenant/bucket`. Re-run locally against the reader for details: the report contains `missingInModern`, `missingInLegacy` and `different` legacy ids per partition.

- `missingInModern`: look for a dead letter for that id (`sync_dead_letters`); if none, the row was changed while the worker was failing — touch it in legacy (`UPDATE ... SET LAST_UPD = LAST_UPD`) to produce a new version.
- `missingInLegacy`: a modern-created customer that the reverse sync has not delivered → [reverse-sync](#reverse-sync).
- `different`: compare the row on both sides; most often a write to the non-owner side → [dead-letters](#dead-letters).

## dead-letters

**Alarm:** `SyncDeadLettered` > 0.

```sql
SELECT stream, reason, count(*) FROM sync_dead_letters WHERE resolved_at IS NULL GROUP BY 1, 2;
```

| reason | meaning | action |
|---|---|---|
| `orphan_invoice` | invoice for a `CUST_ID` that does not exist (no FK in legacy) | business decision per row; known 5 rows in the seed |
| `unknown_customer_status` / `unknown_invoice_status` | a code the ACL does not know | find who writes it; add the mapping with a test, or fix the data in legacy |
| `due_date_invalid`, `reference_month_invalid`, `customer_name_missing` | unusable legacy data | fix in legacy; the new version re-syncs and the dead letter resolves itself |
| `write_to_non_owner` | legacy changed an entity that modern owns for that tenant (**split brain**) | **page**: find the writer (`LAST_UPD_BY` column, SQL Server audit), stop it; re-apply the intended change through the modern API |

Dead letters resolve automatically (`resolved_at`) when a later version of the same row applies cleanly.

## ownership-flip

Moves write ownership of `customers` for one tenant from legacy to modern (phase 4).

1. Preconditions: read routes for customers at 100 % modern for that tenant; `ReverseSyncService` desired count 1 and healthy; `TRG_INV_PAID` unblock rule disabled for the tenant or moved (R-03); the DBA has granted `EXECUTE` on `usp_SyncCustomerFromModern` to `sync_worker`.
2. Freeze customer writes for the tenant (pause the tenant's write callers; < 1 min).
3. Wait for `ReplicationLagSeconds{Stream=customers}` = 0.
4. `curl -X PUT "${A[@]}" https://$GATEWAY/admin/ownership -d '{"entity":"customers","tenantId":"ACME","owner":"modern"}'`
5. Unfreeze. Watch `x-served-by: modern` on writes, `ReverseSyncBacklog`, `write_to_non_owner` dead letters.

## ownership-rollback

1. Freeze customer writes for the tenant.
2. Wait for `ReverseSyncBacklog` = 0 (every modern write is in legacy).
3. `PUT /admin/ownership` with `"owner":"legacy"`.
4. Unfreeze. CDC applies legacy writes again; parity must stay green.

## reverse-sync

**Alarm:** `ReverseSyncBacklog` > 100 for 5 minutes.

```sql
SELECT id, legacy_id, attempts, last_error, created_at
  FROM reverse_sync_outbox WHERE synced_at IS NULL ORDER BY id LIMIT 20;
```

The worker stops at the first failing row to preserve per-customer order. Typical causes: login lacks `EXECUTE` permission, legacy constraint (`UF` longer than 2), SQL Server failover. After fixing, the row is retried on the next pass (up to 10 attempts; reset with `UPDATE reverse_sync_outbox SET attempts = 0 WHERE id = ...`).

## fallbacks

**Alarm:** `GatewayFallback` > 10/min for 3 of 5 minutes. Modern reads failing (5xx or timeout) and being served by legacy. Callers are fine; check the billing service (`/health/ready`, Aurora connections). If it persists for 15 minutes, lower `modernPercent` for the route.

## sync-worker database login (one-off, DBA)

```sql
CREATE LOGIN sync_worker WITH PASSWORD = '<from LegacySyncCredentials secret>';
USE LegacyBilling;
CREATE USER sync_worker FOR LOGIN sync_worker;
GRANT SELECT, VIEW CHANGE TRACKING ON dbo.TBL_CUST TO sync_worker;
GRANT SELECT, VIEW CHANGE TRACKING ON dbo.TBL_INV TO sync_worker;
GRANT VIEW DATABASE STATE TO sync_worker;            -- sys.dm_tran_commit_table (lag metric)
GRANT EXECUTE ON dbo.usp_SyncCustomerFromModern TO sync_worker;  -- phase 4 only
```

`usp_SyncCustomerFromModern` uses `SET IDENTITY_INSERT` and `DBCC CHECKIDENT`, which require `ALTER` on `TBL_CUST`; sign the procedure with a certificate rather than granting `ALTER` to the login.
