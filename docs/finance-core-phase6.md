# Finance Core Phase 6

## Purpose

Phase 6 adds accounts receivable and accounts payable subsidiary ledgers. It turns posted invoices, payments, refunds, and approved carrier bills into auditable open items and currency-safe aging reports.

## Transactional projection

The existing finance posting worker remains the only runtime processor. After a canonical event resolves to one posting rule and a balanced journal is created, the same PostgreSQL transaction updates the subsidiary ledger:

| Canonical event | Subsidiary-ledger result |
| --- | --- |
| `invoice.issued` | Creates one customer receivable open item. |
| `payment.succeeded` | Allocates FIFO to open invoices for the same legal entity, order, and currency. |
| `payment.refunded` | Consumes unapplied receipts, then reopens receivables. |
| `carrier.bill_approved` | Creates one carrier supplier payable open item. |

If any projection fails, the journal and source-event status roll back together and the immutable source event enters the finance exception queue.

An advisory transaction lock serializes subledger changes for the same legal entity and order. Unique source-event keys provide idempotency in addition to the posting pipeline's existing deduplication.

## Timing differences

A payment may arrive before its invoice. The amount is stored as unapplied cash instead of being discarded or forced into an unrelated invoice. When the invoice posts, available receipts for the same order and currency are applied FIFO.

If a payment exceeds outstanding receivables, only the valid balance is allocated and the remainder stays unapplied. A refund first reduces unapplied receipts and then reopens prior receivables up to their original amount. Any remaining refund difference stays visible as unapplied refund cash for finance review.

## Aging reports

Endpoints:

- `GET /api/finance/receivables/aging?asOf=YYYY-MM-DD`
- `GET /api/finance/receivables/unapplied-cash`
- `GET /api/finance/payables/aging?asOf=YYYY-MM-DD`

Optional filters:

- both: `currency`, `cursor`, `limit`
- receivables: `customerEntityId`
- payables: `carrierProviderId`

Buckets are `current`, `1-30`, `31-60`, `61-90`, and `over 90` calendar days overdue. Receivable and payable balances are reconstructed from allocations whose occurrence time is on or before the report date, so a historical report does not reuse today's balance.

Summaries are grouped by original currency. UZS, USD, and CNY are never summed into a false mixed-currency total.

Permissions:

- `finance.receivables.read`
- `finance.payables.read`

## Boundaries

- The general ledger remains the accounting book of record.
- The subsidiary ledger explains who owes or is owed each balance.
- Analytics and Redis are not authoritative for aging.
- Phase 6 does not execute supplier payments or bank reconciliation. Those commands will create immutable payable allocations in the next phase.

## Deployment

1. Apply migration `20260802170000_finance_subledgers` after Finance Phase 5.
2. Run the permission seed so owner roles receive `finance.receivables.read`.
3. Keep the existing finance posting and finance outbox workers running; no new worker is required.
4. Post a test invoice, payment, partial refund, and approved carrier bill.
5. Verify the two aging endpoints by currency and historical `asOf` date.
6. Review `/api/finance/exceptions` if an event cannot project.
