# Local end-to-end run and measurements

What was run, on what, and what came out. These numbers describe a developer laptop, not production capacity.

## Environment

- Windows 11 laptop, Docker Desktop; SQL Server 2022 CU14 container limited to 2 GB / `MSSQL_MEMORY_LIMIT_MB=1536`, PostgreSQL 16 (alpine) container, Node 22.21.
- The machine was shared: other projects were being built and tested concurrently, so absolute timings are noisy.
- Seed: 3,000 customers and 12,005 invoices (`SEED_CUSTOMERS=3000`), three tenants. All four processes (legacy app, billing service, gateway, CDC worker) ran as plain Node processes against the compose stack.
- Latencies were measured with a sequential Node `fetch` loop (1 request in flight, 3,000 requests per run), client on the same machine.

## Results

| What | Result |
|---|---|
| Backfill, throttled at 2,000 rows/s (15,005 rows) | 9.4 s wall clock, including process start |
| Backfill, unthrottled | 5.3 s wall clock, including process start |
| Backfill outcome | 3,000 customers (15 soft-deleted kept as tombstones), 12,000 invoices, 5 dead letters (`orphan_invoice`, all seeded orphans) |
| Steady-state replication lag, single-row legacy update → visible in PostgreSQL (30 probes) | p50 941 ms, p95 972 ms, max 982 ms; dominated by `SYNC_POLL_INTERVAL_MS=1000` |
| Catch-up after a 12,005-row single-statement `UPDATE` (one CT version) | 6.2 s including worker start (after the fix below) |
| Shadow reads, 100 % sampled, `customers.get` | 3,000 compared, **0 mismatches** |
| Shadow reads, 100 % sampled, `invoices.list` | 3,000 compared, **0 mismatches** |
| Parity checker, full dataset | 47 partitions, 15,000 rows compared, 5 excluded (orphans), 0 mismatched, 2.3 s |

The zero mismatch result is on the seeded data with the accepted-difference rules of ADR 0006 in place. Before those rules, every customer with a padded e-mail, punctuated document or `YYYY-MM-DD` date and every open past-due invoice was a "mismatch".

### Latency per routing mode (`GET /api/customers/:id`, ms)

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Legacy app direct | 3.9 | 6.6 | 8.2 |
| Billing service (compat API) direct | 3.2 | 4.4 | 5.9 |
| Gateway → legacy, 100 % shadow to modern | 6.1 | 8.6 | 12.4 |
| Gateway → legacy, no shadow | 3.7 | 7.4 | 9.2 |
| Gateway → modern, no shadow | 2.8 | 4.3 | 5.8 |
| Gateway, `modernPercent=30` (946 of 3,000 served by modern, 31.5 %) | 3.6 | 5.9 | 6.9 |

Runs were sequential and the first direct runs were partly cold, which is why "gateway → modern" can come out faster than "billing direct". The only conclusion we draw: on this machine the facade hop is in the low single-digit milliseconds, and 100 % shadow sampling roughly doubles the work per request on the gateway host. Not a production benchmark.

## Defect found by this run

The first catch-up attempt after the 12,005-row `UPDATE` failed in a loop with PostgreSQL `08P01 bind message has 24928 parameter formats but 0 parameters`: one Change Tracking version is read unbounded (by design, a version is never split), and the resulting single `INSERT ... ON CONFLICT` exceeded PostgreSQL's 65,535 bind-parameter limit. The integration tests had not caught it because their largest transaction touched ~200 rows. Fixed by chunking every multi-row statement in the projector (1,000 rows per statement); the checkpoint had not moved, so the worker resumed cleanly after the fix was deployed.

## Reproduce

```bash
docker compose up -d --wait mssql postgres
npm ci && npm run build
npm run legacy:init && npm run migrate
npm run sync:backfill
npm run start:legacy & npm run start:billing & npm run start:gateway & npm run sync:cdc &
```

Then set rules through the admin API (see README) and drive traffic. Stop everything and run `docker compose down` afterwards; the SQL Server container alone needs ~2 GB of RAM.
