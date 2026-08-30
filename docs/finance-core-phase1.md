# Finance Core Phase 1

## Scope

Phase 1 establishes the accounting kernel. It does not replace payment collection, cash custody, invoice generation, or pricing. Those modules become finance source-event producers in later phases.

Implemented capabilities:

- one finance legal entity per company organization;
- active currencies restricted to `UZS`, `USD`, and `CNY`;
- hierarchical chart of accounts;
- fiscal periods with open, restricted, and closed states;
- fixed-precision multi-currency journal lines;
- balanced draft creation, posting, and reversal;
- immutable posted history and append-only audit events;
- cursor-paginated journal, account, and period reads;
- base-currency trial balance;
- transactional finance domain outbox and dedicated Redis publisher worker.

## Accounting invariants

1. Every journal has at least two lines.
2. Each line has exactly one positive debit or credit.
3. Transaction-currency and base-currency totals must balance.
4. Posting is allowed only into an open fiscal period.
5. Accounts must belong to the actor's company finance entity and remain active/postable at posting time.
6. Manual journals cannot post directly to control accounts.
7. Posted journals are never edited or deleted. Corrections use linked reversal journals.
8. Reversed originals remain in ledger reports together with their offsetting reversal.
9. Base currency is locked after the first posting; fiscal-year start is locked after periods exist.
10. Every state-changing transaction also writes an audit record and domain outbox event.

## API

All routes are under `/api/finance` and derive company scope from the authenticated membership.

- `GET|PUT /legal-entity`
- `GET|POST /accounts`
- `GET|POST /periods`
- `PATCH /periods/:id/status`
- `GET|POST /journals`
- `GET /journals/:id`
- `POST /journals/:id/post`
- `POST /journals/:id/reverse`
- `GET /reports/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD`

No route accepts a client-selected company ID.

## Runtime

Development:

```powershell
npm run worker:finance-outbox
```

Production:

```text
node dist/src/workers/finance-outbox.worker.js
```

The Docker Compose stack starts `finance-outbox-worker` automatically. The worker claims rows through PostgreSQL `FOR UPDATE SKIP LOCKED`, publishes to `${REDIS_PREFIX}:cp:finance:events`, and retries failures with bounded exponential backoff.

## Next phases

1. Standard chart-of-accounts templates and posting-rule administration. Implemented in `finance-core-phase2.md`.
2. Idempotent source adapters for invoices, provider payments, refunds, and cash custody.
3. Carrier accruals, supplier bills, accounts payable, and approval workflows.
4. Bank/cash reconciliation and FX-rate governance.
5. General ledger, P&L, balance sheet, cash flow, AR/AP aging, and period-close UI.
