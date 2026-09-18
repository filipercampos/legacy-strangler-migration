# 4. Anti-corruption layer between the legacy schema and the billing domain

- Status: Accepted
- Date: 2026-09-17

## Context

The legacy model encodes meaning in formats and codes: `CUST_STAT = 'B'` means "suspended for non-payment", `INV_STAT = 2` means "open and past due, as of the last nightly job", `PAY_DT = '00000000'` means "not paid", `DT_REG` is `DD/MM/YYYY` except when it is `YYYY-MM-DD`, empty or `31/02/2019`. If these leak into the new service, the new domain inherits the old one's design and the migration buys nothing.

The translation is needed in three places: the CDC/backfill path (legacy rows → domain), the compat API (domain → legacy HTTP contract while callers still speak it), and verification (shadow reads and parity must compare like with like).

Options considered:

| Option | Pros | Cons |
|---|---|---|
| Copy legacy columns 1:1 into PostgreSQL, clean later | Fast first load | "Later" never comes; every consumer re-implements the decoding |
| Translate in SQL views on the legacy side | Close to the data | More T-SQL in a system we are leaving; cannot be unit tested with the domain |
| Translate in DMS transformation rules | Managed | Only rename/filter/simple expressions; no date validation or status semantics |
| **ACL module in the new codebase**, pure functions, both directions | Unit-testable, single place that knows legacy codes, reused by sync, compat API and verification | One more module to own; it must be deleted together with the legacy system |

## Decision

`src/acl` is the only code allowed to import legacy types (`src/legacy/contract.ts`) and the domain together.

- **Inbound** (`translateCustomer`, `translateInvoice`): legacy row → domain aggregate. Normalizes (trimmed lower-case e-mail, digits-only CPF/CNPJ with kind, ISO dates, integer cents) and records a list of *issues* for every repair (`email_invalid`, `registration_date_invalid:31/02/2019`, `paid_without_payment_date`, ...). Issues are stored with the row (`data_issues`) to feed a data-quality backlog instead of being silently fixed.
- **Rejections**: when meaning is unknowable (unknown status code, unparseable due date, negative amount) the row raises `AclRejection` and the sync worker dead-letters it. Defaults are never invented.
- **Soft delete** (`CUST_STAT = 'X'`) becomes a tombstone (`deleted_at`), not a status.
- **"Overdue" is derived**, not stored: legacy `2` maps to `open`; the outbound side computes `2` from the due date at read time. This intentionally differs from legacy until the nightly job runs; the shadow comparator treats `0`/`2` on past-due invoices as equivalent ([ADR 0006](0006-verification-shadow-reads-and-parity.md)).
- **Identity**: modern ids are deterministic UUIDs derived from the legacy id (`modernIdFor('customer', 17)`), so backfill, CDC replays and the compat API agree on identity without a mapping table. Customers created by the modern service take legacy-compatible ids from a disjoint range (≥ 50,000,000) so the reverse sync can write them to `TBL_CUST`.
- **Outbound** (`customerToLegacy`, `invoiceToLegacy`): domain → legacy contract, canonical formatting (always `DD/MM/YYYY`, punctuated documents).

## Consequences

- The domain has no knowledge of `A/B/S/C/X` or `0/1/2/7/9`; when legacy is switched off, `src/acl` and `src/legacy` are deleted and nothing else changes.
- Translation is lossy where legacy data is wrong (`31/02/2019` → `null`). That loss is visible: the issue is stored, shadow reads report it, and the parity checker compares the translated form on both sides.
- Round-trip fidelity is tested for every status code; a new legacy code fails loudly in the dead-letter queue, not as a wrong invoice.
