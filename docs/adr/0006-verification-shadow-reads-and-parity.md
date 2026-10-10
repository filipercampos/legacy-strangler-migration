# 6. Verification: semantic shadow reads and a partitioned parity checker

- Status: Accepted
- Date: 2026-10-09

## Context

Before any caller is served by the modern service we need evidence, not hope, that it answers the same thing legacy does. Two different questions:

1. **Does the modern API behave like legacy for real requests?** Covers the ACL outbound mapping, query logic, sync lag as seen by callers.
2. **Does PostgreSQL hold the same data as SQL Server?** Covers the sync worker, dead letters, deletes, rows nobody reads.

A byte-for-byte comparison is useless here: the modern side normalizes on purpose (e-mail case, document punctuation, ISO dates). Every response would "differ" and the signal would drown.

## Decision

### Shadow reads (gateway)

- A sampled share of read requests (`shadowPercent` per route/tenant) is sent to the side that did **not** serve the caller, after the response has been returned. Never for writes.
- Both bodies are reduced to a **canonical form** ([`canonical.ts`](../../src/gateway/shadow/canonical.ts)) that removes exactly the *accepted* differences, then deep-diffed by path:

| Accepted difference | Canonical rule |
|---|---|
| E-mail padding / case | trimmed lower-case |
| `123.456.789-01` vs `12345678901` | digits; invalid documents (`ISENTO`) → null on both sides |
| `DD/MM/YYYY` vs `YYYY-MM-DD`; impossible dates | ISO or null |
| Unpaid as `NULL`, `''`, `00000000` | null |
| Overdue `2` vs open `0` | both `open` (legacy flips it in a nightly batch) |
| `MONEY` 4 decimals vs cents | integer cents |

- Anything that still differs is a mismatch: metric `ShadowMismatch` / `ShadowCompared` per route (alarm on the rate), log line with field **paths only** (no values, no PII), and a full sample in `shadow_mismatches` (restricted table, 14-day retention).
- Status codes must match; error bodies are not compared.

### Parity checker (batch job)

- Partitions both stores by `tenant × legacy-id bucket` (default 1,000 ids). For each partition: row count and a SHA-256 over the **canonical form of the translated rows** on both sides (legacy rows go through the inbound ACL first, so "equal" means "equal after translation").
- Mismatching partitions are drilled down to row level and reported (missing in modern, missing in legacy, different).
- Emits `ParityMismatchedPartitions` and is scheduled hourly during the transition; it is an exit criterion for every phase ([cutover plan](../cutover-plan.md)).

## Consequences

- The list of accepted differences is explicit and reviewed; adding a rule is a code change with a test, not a dashboard filter.
- Shadow traffic doubles read load on the shadowed side for the sampled share; sampling is per route and tenant to keep that bounded (legacy primary CPU is watched during shadow phases).
- Shadow reads see sync lag as mismatches for rows changed in the last seconds. The rate alarm threshold (0.5 %) and the parity checker (which runs on a stable snapshot) separate lag from real defects.
- The parity checker reads every legacy row once per run; it runs against the RDS read replica in production.
