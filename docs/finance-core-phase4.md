# Finance Core Phase 4

## Purpose

Phase 4 introduces authoritative commercial documents for customer receivables and payment refunds. It keeps operational provider communication in payments-core while finance-core receives only canonical, confirmed facts.

## Invoice issuance

`POST /api/invoices/orders/:orderId/issue` creates or issues one invoice for an order. The backend reads the persisted pricing components and snapshots:

- company and customer scope;
- invoice number and order reference;
- amount and original currency;
- FX rate and FX timestamp;
- issue and due dates;
- the pricing source and component count.

The client cannot provide an invoice amount or currency. Repeating issuance for an already issued invoice returns the same document. Cancelled or credited invoices cannot be silently reissued.

Invoice issuance and its `invoice:invoice.issued` domain-outbox event commit in one PostgreSQL transaction. Finance posting then applies the active versioned posting rule.

Endpoints:

- `GET /api/invoices`
- `POST /api/invoices/orders/:orderId/issue`
- `GET /api/invoices/orders/:id/url`

Permissions:

- `finance.invoices.read`
- `finance.invoices.issue`

## Payment refunds

`POST /api/payments/intents/:id/refund` requires a company ID and an idempotency key. The backend validates company scope, provider status, successful payment state, and remaining refundable amount before calling the provider adapter.

Every request is stored in `PaymentRefund` with one of these states:

- `requested`
- `processing`
- `succeeded`
- `failed`
- `cancelled`

Only `succeeded` creates a refund ledger entry, updates the aggregate payment state, updates the order payment state, and emits `refund:payment.refunded`. Partial refunds keep the intent partially refunded; the final successful remainder marks it fully refunded.

The same company-scoped idempotency key cannot be reused for another payment or amount. Refund reservation is serialized per payment intent and includes successful plus in-flight amounts, preventing concurrent over-refunds without holding a database transaction during the provider call. Raw provider responses are retained for operations and audit but are never returned through the public API.

Endpoint:

- `GET /api/payments/intents/:id/refunds`
- `POST /api/payments/intents/:id/refund`

Permission:

- `finance.refund`

Stripe and Click use their implemented refund adapters. A provider adapter that does not support refunds records a durable failure instead of reporting false success.

## Accounting boundary

Phase 4 deliberately does not infer provider expenses or carrier liabilities:

- payment-provider fees require a provider balance transaction or settlement report;
- carrier costs require an accepted supplier invoice, contract-rated service entry, or approved settlement;
- analytics projections, booking acknowledgements, and quoted values are not authoritative accounting documents.

Provider settlement statements and carrier supplier bills use the same source-event, posting-rule, exception, and journal pipeline in Finance Phase 5.

## Deployment

1. Apply migration `20260802150000_finance_refunds_invoices`.
2. Seed system permissions.
3. Configure invoice and refund posting rules for each legal entity.
4. Deploy the API, finance posting worker, and finance outbox publisher.
5. Issue a test invoice and execute partial and full sandbox refunds.
6. Confirm the resulting source events, journals, and exception queue.

Never apply this migration before the UUID v7 database function and Finance Phases 1-3 migrations are present.
