# Threat model (STRIDE)

Scope: strangler gateway (facade + admin API), billing service, sync workers (CDC, backfill, reverse sync, parity), RDS SQL Server, Aurora PostgreSQL, Secrets Manager. The legacy application itself is out of scope (unchanged), but the migration must not weaken it.

Trust boundaries: internal callers → internal ALB → gateway; gateway → legacy app / billing service (Service Connect); sync workers → both databases; ops VPN → admin API.

| Threat | Example | Mitigation |
|---|---|---|
| **Spoofing** | Someone on the VPC calls the admin API and routes all traffic to a half-ready modern side | `/admin/*` is answered 403 by the ALB unless the source is the ops VPN CIDR; the gateway also requires the admin token (Secrets Manager, compared in constant time) and an actor header |
| **Spoofing** | A caller forges `X-Tenant-Id` to read another tenant's customers | Unchanged from legacy: tenant comes from the caller's integration config at the edge; the migration adds no new trust in the header. Both legacy procedures and modern queries filter by tenant, and shadow reads would expose any divergence |
| **Tampering** | A forgotten legacy job writes to customers after modern owns them; data silently diverges | Single-writer rule: CDC refuses and dead-letters `write_to_non_owner` (paging alarm); parity checker catches anything else hourly |
| **Tampering** | Reverse-sync echo loops or overwrites newer legacy data | Change Tracking context marks reverse-sync writes and CDC skips them; ownership guarantees only one side writes; full-snapshot payloads applied in order by a single worker |
| **Tampering** | Replayed or reordered CDC batches overwrite newer state | `source_version` guard on every upsert; checkpoint advanced in the same transaction as the data |
| **Repudiation** | "Who moved 50 % of GLOBEX to modern on Friday night?" | Every rule, kill-switch and ownership change is written to `routing_audit` with the actor, in the same transaction as the change; ALB access logs; CloudTrail for secret access |
| **Information disclosure** | Shadow diffs leak customer data into logs | Logs contain field paths only; full samples go to `shadow_mismatches` (restricted role, 14-day purge); authorization / cookie / admin-token headers redacted from request logs |
| **Information disclosure** | Sync worker credentials over-privileged on the legacy database | Dedicated `sync_worker` login: `SELECT` + `VIEW CHANGE TRACKING` on two tables, `VIEW DATABASE STATE`, `EXECUTE` on one procedure (signed for the `ALTER` it needs); credentials in Secrets Manager, injected by ECS, never in env files or images |
| **Information disclosure** | Data in transit between VPC services | TLS to RDS SQL Server (`encrypt: true`, RDS CA), `sslmode=require` to Aurora, HTTPS on the ALB (TLS 1.2+ policy); storage encrypted on both databases |
| **Denial of service** | Shadow traffic or the backfill overloads the legacy primary | Shadow sampling per route; backfill token bucket; parity on a reader where available; legacy CPU watched during phases |
| **Denial of service** | Modern service outage takes callers down | Read fallback to legacy on 5xx/timeout (`x-fallback`), kill switch, upstream timeout 3 s, shadow timeout 1.5 s and never on the request path |
| **Elevation of privilege** | Billing service writes for a tenant legacy still owns | Ownership row read `FOR SHARE` in the write transaction; `409 not_entity_owner`; gateway routes writes to the owner only |
| **Elevation of privilege** | Arbitrary SQL through the generic route forwarding | The facade forwards only a fixed header allow-list and the original path to fixed upstream base URLs (no user-controlled host); all SQL is parameterized (`mssql` inputs, Kysely) and table names in the sync worker come from a static map |

## Out of scope / accepted risks

- A DBA with `sysadmin` on SQL Server can disable Change Tracking or triggers. Organisational control (break-glass, RDS audit logs), not code.
- Shared admin token instead of per-user identity on the admin API. Accepted for the migration period because the API is VPN-only and every call carries an actor; IAM-authenticated admin (API Gateway + SigV4) is on the backlog.
