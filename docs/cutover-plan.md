# Cutover and rollback plan

The migration is a sequence of small, reversible steps. Each phase has entry criteria (what must be true before starting), exit criteria (evidence needed to move on) and a rollback that has been rehearsed in staging. Phases run **per route and per tenant**; `ACME` (best data quality) goes first, `INITECH` (most broken dates) last.

Decision makers: migration lead (go/no-go), billing product owner (accepts behaviour differences), DBA on call (legacy side).

## Phase 0 — Foundations: facade in front, 100 % legacy

| | |
|---|---|
| Entry | Gateway deployed in every environment; callers' base URL switched to the gateway one caller at a time |
| Work | No routing rules (default = legacy). Unknown routes pass through untouched |
| Exit | All callers on the gateway for 7 days; gateway p99 overhead measured and accepted; 5xx rate unchanged |
| Rollback | Caller points back at the legacy URL (config change per caller) |

## Phase 1 — Replicate: backfill + CDC

| | |
|---|---|
| Entry | Change Tracking enabled on `TBL_CUST`, `TBL_INV` (retention 3 days); `sync_worker` login created; Aurora migrated |
| Work | `sync backfill` (throttled, resumable), then CDC service starts from the snapshot version |
| Exit | `ReplicationLagSeconds` p99 < 60 s for 7 days; parity checker 0 mismatched partitions for 3 consecutive days; every open dead letter triaged (fixed in legacy, or accepted as exclusion) |
| Rollback | Nothing to roll back for callers (no traffic yet). Bad data: truncate, re-backfill |

## Phase 2 — Shadow reads

| | |
|---|---|
| Entry | Phase 1 exit met; compat endpoints deployed |
| Work | `shadowPercent` 1 → 10 → 50 % per read route, `modernPercent` 0. Every mismatch class is investigated: either a bug (fix, redeploy) or an accepted difference (new canonical rule + ADR 0006 table + product owner sign-off) |
| Exit | `ShadowMismatch / ShadowCompared` < 0.5 % for 7 days on ≥ 10,000 comparisons per route; no unexplained mismatch class; legacy primary CPU increase from shadow traffic < 10 % |
| Rollback | `shadowPercent` 0 (flag, seconds) |

## Phase 3 — Canary reads

| | |
|---|---|
| Entry | Phase 2 exit met for the route; on-call briefed; dashboards per route show `x-served-by` split |
| Work | `modernPercent` 1 → 5 → 25 → 50 → 100 % per route and tenant, at least 24 h per step; shadow stays at 10 % (now comparing against legacy) |
| Exit | At 100 % for 14 days: 5xx and p99 latency not worse than legacy baseline, `GatewayFallback` ≈ 0, mismatch rate < 0.5 % |
| Rollback | **Instant**: `PUT /admin/rules` with lower percentage, or `POST /admin/kill-switch {"on":true}` for everything. Reaches all gateway tasks within the 2 s flag cache TTL. No data to reconcile (reads only) |

## Phase 4 — Write ownership, per tenant

| | |
|---|---|
| Entry | Phase 3 exit for all read routes of the entity; hidden writers inventoried (SQL Agent jobs, triggers, scripts) and either moved or disabled — for customers that includes `TRG_INV_PAID`'s unblock rule (R-03); reverse sync deployed with desired count 1 and rehearsed; `write_to_non_owner` alarm paging |
| Work | Runbook [ownership flip](runbook.md#ownership-flip) per tenant: freeze writes for the tenant (< 1 min; today by pausing that tenant's write callers — a gateway-level freeze flag is on the backlog), drain CDC to lag 0, `PUT /admin/ownership {"owner":"modern"}`, unfreeze |
| Exit | 14 days with: reverse sync backlog < 100, parity green (legacy kept complete by reverse sync), zero `write_to_non_owner` dead letters |
| Rollback | Freeze writes for the tenant, wait until `ReverseSyncBacklog` = 0, flip ownership back to legacy, unfreeze. CDC resumes applying legacy changes. **Data written by modern is already in legacy** thanks to the reverse sync; nothing is lost. Practised in staging before each tenant |

## Phase 5 — Callers to `/v2`

| | |
|---|---|
| Entry | All tenants of the entity owned by modern for 30 days |
| Work | Callers migrate from the legacy contract to `/v2` at their own pace; gateway metric `GatewayRequests{Route=customers.*}` shows remaining compat traffic per caller |
| Exit | Compat traffic 0 for 30 days |
| Rollback | Caller-side (they can keep using the compat endpoints) |

## Phase 6 — Decommission

| | |
|---|---|
| Entry | Phase 5 exit for every entity; finance sign-off on parity reports; legal retention plan for the SQL Server data |
| Work | Legacy app removed from the route table; SQL Server set read-only; final parity report archived; CDC, reverse sync, parity, compat controller, `src/acl`, `src/legacy` deleted; final snapshot kept per retention policy; RDS SQL Server deleted |
| Exit | SQL Server licence cost gone |
| Rollback | Restore the final snapshot (read-only use). This is the only one-way door, so it is the last step |

## Go / no-go checklist (every step)

- [ ] Exit criteria of the previous step met, with links to the dashboards
- [ ] Rollback for this step written down and rehearsed in staging this week
- [ ] On-call (app + DBA) aware, not during month-end billing close (days 28–3)
- [ ] Alarm topic subscribed by the on-call rotation
- [ ] Change recorded in `routing_audit` (automatic) and in the change calendar
