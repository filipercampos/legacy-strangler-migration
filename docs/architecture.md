# Architecture

## System context (C4 level 1)

```mermaid
flowchart LR
  callers[Internal callers<br/>portal, collections, ERP export, ...] -->|legacy HTTP contract| facade[Strangler gateway]
  facade --> legacy[Legacy billing app<br/>Express + stored procedures]
  facade --> modern[Billing service<br/>NestJS]
  legacy --> mssql[(RDS SQL Server<br/>TBL_CUST, TBL_INV)]
  modern --> aurora[(Aurora PostgreSQL)]
  mssql -->|Change Tracking| sync[Sync worker]
  sync --> aurora
  aurora -->|reverse_sync_outbox| sync
  sync -->|usp_SyncCustomerFromModern| mssql
  ops[Migration team] -->|flags, kill switch, ownership| facade
```

## Containers (C4 level 2)

```mermaid
flowchart TB
  subgraph ECS[ECS Fargate]
    gw[gateway<br/>dist/gateway/main.js<br/>routing, shadow reads, admin API]
    bill[billing-service<br/>dist/billing/main.js<br/>/v2 API + legacy-compatible /api]
    cdc[sync cdc<br/>Change Tracking -> PostgreSQL]
    rev[sync reverse<br/>outbox -> SQL Server]
    par[sync parity<br/>hourly scheduled task]
    bf[sync backfill<br/>one-off task]
  end
  gw -->|Service Connect| bill
  gw -->|existing internal URL| leg[legacy app]
  gw --> pg[(Aurora: routing_rules, entity_ownership,<br/>shadow_mismatches, routing_audit)]
  bill --> pg2[(Aurora: customers, invoices,<br/>reverse_sync_outbox)]
  cdc --> pg2
  bf --> pg2
  par --> pg2
  rev --> pg2
  cdc --> sql[(RDS SQL Server)]
  bf --> sql
  par --> sql
  rev --> sql
  gw & bill & cdc & rev & par -->|EMF logs| cw[CloudWatch metrics + alarms]
```

One image, one codebase; the ECS task definition selects the entrypoint. The gateway and the billing service share the Aurora cluster (separate tables); in a larger organisation the gateway's flag tables would move to AppConfig ([ADR 0005](adr/0005-feature-flag-routing.md)).

## Code map

| Path | Role | Deleted at decommission? |
|---|---|---|
| `legacy/sql/` | Legacy schema, triggers, procedures, seed (the system being replaced) | yes |
| `src/legacy/` | Legacy Express app + its HTTP contract types | yes |
| `src/billing/domain/` | Clean domain: `Customer`, `Invoice`, value objects | no |
| `src/billing/api/` | `/v2` API | no |
| `src/billing/compat/` | Legacy-compatible endpoints, modern-side writes with ownership check | yes |
| `src/acl/` | Anti-corruption layer (codes, dates, documents, money, ids) | yes |
| `src/gateway/` | Facade: route table, `decide()`, flag store, shadow reads, admin API | yes |
| `src/sync/` | Backfill, CDC worker, projector, reverse sync, parity checker | yes |
| `src/shared/` | Config, database, Nest core module, logging, tracing, EMF metrics | no |

## Data flow of a read during a canary phase

```mermaid
sequenceDiagram
  participant C as Caller
  participant G as Gateway
  participant L as Legacy
  participant M as Modern
  C->>G: GET /api/customers/42 (X-Tenant-Id: ACME)
  G->>G: decide(): bucket(ACME:42)=43 < 50% -> modern, shadow sampled
  G->>M: GET /api/customers/42
  M-->>G: 200 legacy-shaped JSON (outbound ACL)
  G-->>C: 200 (x-served-by: modern)
  G->>L: GET /api/customers/42 (after response)
  L-->>G: 200
  G->>G: canonicalize both, deep diff, emit ShadowCompared / ShadowMismatch
```

## Data flow of a legacy write

```mermaid
sequenceDiagram
  participant L as Legacy app
  participant S as SQL Server
  participant W as CDC worker
  participant P as PostgreSQL
  L->>S: EXEC usp_PayInvoice (trigger unblocks customer)
  S->>S: Change Tracking records TBL_INV + TBL_CUST (same version)
  W->>P: BEGIN; SELECT checkpoint FOR UPDATE
  W->>S: SNAPSHOT: CHANGETABLE(CHANGES ..., checkpoint) JOIN base rows
  W->>W: ACL translate, dead-letter rejects / orphans / non-owner writes
  W->>P: upsert ... WHERE source_version < excluded.source_version
  W->>P: UPDATE checkpoint; COMMIT
```

## Migration phases

```mermaid
flowchart LR
  P0[0. Foundations<br/>gateway in front,<br/>100% legacy] --> P1[1. Replicate<br/>backfill + CDC,<br/>parity green]
  P1 --> P2[2. Shadow<br/>reads compared,<br/>mismatch < 0.5%]
  P2 --> P3[3. Canary reads<br/>1 -> 10 -> 50 -> 100%<br/>per route/tenant]
  P3 --> P4[4. Write ownership<br/>per tenant + reverse sync]
  P4 --> P5[5. Callers to /v2<br/>compat traffic -> 0]
  P5 --> P6[6. Decommission<br/>legacy read-only,<br/>then retired]
  P3 -.rollback: flag.-> P2
  P4 -.rollback: ownership flip back.-> P3
```

Entry/exit criteria and rollback per phase: [cutover-plan.md](cutover-plan.md).

## Observability

- **Logs**: pino JSON, one line per request with `x-request-id` propagated by the gateway to both upstreams, so a shadow read's two calls share the id. Admin token and auth headers redacted.
- **Traces**: OpenTelemetry Node SDK (http, express, pg, tedious auto-instrumentation) exporting OTLP to the ADOT sidecar → X-Ray; `traceparent` forwarded through the facade.
- **Metrics** (CloudWatch EMF, namespace `StranglerMigration`): `GatewayRequests{Route,Target}`, `UpstreamLatency`, `GatewayFallback`, `ShadowCompared/ShadowMismatch/ShadowError/ShadowLatencyDelta{Route}`, `ReplicationLagSeconds/SyncChangesApplied/SyncDeadLettered/SyncEchoesSkipped{Stream}`, `BackfillRows/BackfillThrottled`, `ReverseSyncBacklog`, `ParityMismatchedPartitions`.
- **Health**: `/health/live` (process) and `/health/ready` (PostgreSQL / SQL Server reachable) on every HTTP process.
