# Finance Core Phase 3

## Purpose

Phase 3 connects trusted operational transactions to the accounting kernel. Business modules publish facts; finance owns account resolution, journal construction, posting, audit, retry, and exceptions.

## Processing path

1. A payment or cash-custody transaction commits its business state and a `finance_source_event` outbox row together.
2. The existing domain-outbox publisher delivers the envelope to the shared Redis stream.
3. The finance posting consumer stores the canonical payload in `FinanceSourceEvent`, deduplicated by company and source event ID.
4. A database batch claim selects pending events with `FOR UPDATE SKIP LOCKED`.
5. The posting service resolves exactly one active rule by legal entity, source, event, effective date, priority, and conditions.
6. Trusted amount keys are expanded into balanced debit/credit lines.
7. The finance document, posted journal, source-event result, audit event, and finance outbox event commit in one transaction.
8. A deterministic configuration or validation failure becomes a visible exception instead of being retried indefinitely.

Redis is transport only. PostgreSQL remains the source of truth, so a Redis outage delays processing without losing finance facts.

## Current canonical producers

- successful online payment: `payment:payment.succeeded` with `gross_amount`;
- cash collection: `cash_custody:cash.collected` with `service_charge` or `cod_amount`;
- cash handoff: `cash_custody:cash.handed_off`;
- cash settlement: `cash_custody:cash.settled`.

Every event carries company, source identity, operational dimensions, original currency, FX snapshot metadata, actor, and occurrence/posting dates. Event IDs derive from immutable payment intents or cash event rows.

## Safety guarantees

- same source event ID plus same payload is idempotent;
- same source event ID plus different payload is rejected;
- only backend-registered source/event and amount-key combinations are accepted;
- foreign-currency posting requires `fxRateAsOf`;
- closed or missing fiscal periods cannot receive automatic postings;
- unresolved or equal-priority rule matches are isolated;
- account currency/status/postability is revalidated at processing time;
- document and journal numbers are allocated transactionally;
- no business module stores account IDs or debit/credit instructions.

## Exception APIs

- `GET /api/finance/source-events`
- `GET /api/finance/exceptions`
- `POST /api/finance/source-events/:id/retry`

Permissions:

- `finance.exceptions.read`
- `finance.exceptions.manage`

Retry does not edit the source payload. Finance setup or rules must be corrected first, then the immutable event is returned to pending state.

## Runtime

Required worker:

```text
node dist/src/workers/finance-posting.worker.js
```

Local stack opt-out:

```text
DEV_STACK_NO_FINANCE_POSTING=true
```

The worker has two deterministic stages: Redis ingestion and `processFinancePostingBatchOnce()`. The latter can be invoked in integration tests without running an infinite loop.

## Deployment sequence

1. Apply `20260802140000_finance_source_events`.
2. Seed the new permissions.
3. Configure a finance legal entity and install the standard chart.
4. Create an open fiscal period.
5. Create and activate posting rules for the enabled producers.
6. Deploy API, analytics outbox publisher, finance posting worker, and finance outbox publisher.
7. Review `/api/finance/exceptions` before treating automatic posting as operationally complete.

## Follow-on source integrations

Invoice issuance and confirmed payment refunds are implemented in Phase 4. Provider-fee settlement and carrier-cost accrual remain deferred until their provider settlement reports or approved supplier documents expose authoritative amounts. They must not be synthesized from analytics projections.
