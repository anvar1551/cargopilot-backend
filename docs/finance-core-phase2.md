# Finance Core Phase 2

## Purpose

Phase 2 makes the accounting kernel configurable without embedding account IDs or journal mappings in orders, payments, cash, or integrations code.

## Standard logistics chart

`logistics_standard` version `1` installs a CargoPilot-oriented chart containing:

- cash, bank, payment-provider clearing, and receivables;
- driver-held cash and customer COD liabilities;
- accounts payable, tax control, and carrier accruals;
- delivery, surcharge, insurance, and other operating revenue;
- carrier, last-mile, warehouse, provider-fee, and claims costs;
- operating expenses, retained earnings, and FX gain/loss accounts.

Installation rules:

1. Finance legal entity must already exist.
2. The chart must be empty.
3. Installation runs in one transaction.
4. Retrying the same template/version is idempotent.
5. Installation writes an audit event and finance outbox event.

## Versioned posting rules

Posting rules map canonical business events to finance accounts. Business modules publish facts; they do not choose debit and credit accounts.

Supported source families:

- invoice;
- payment;
- refund;
- cash custody;
- carrier cost.

Rules use a restricted amount-key DSL such as `gross_amount`, `service_charge`, `cod_amount`, `fee_amount`, and `carrier_cost`. Arbitrary code or SQL expressions are not accepted.

Rule guarantees:

- accounts must belong to the authenticated company finance entity;
- accounts must be active and postable;
- source and event combinations come from the backend catalog;
- every amount key currently has exactly one debit and one credit line;
- rule contents are immutable after creation;
- edits create a new numbered version;
- only one version per rule code may be active;
- every change is audited and added to the finance outbox.

## API additions

- `GET /api/finance/setup/catalog`
- `POST /api/finance/accounts/bootstrap`
- `GET|POST /api/finance/posting-rules`
- `GET /api/finance/posting-rules/:id`
- `POST /api/finance/posting-rules/:id/versions`
- `PATCH /api/finance/posting-rules/:id/status`

## Next acceptance target

Implement an idempotent source-event posting service that:

1. receives a canonical finance event;
2. resolves one active rule by company, source, event, date, priority, and conditions;
3. resolves amount keys from trusted server-side payloads;
4. creates and posts a balanced finance document and journal transactionally;
5. deduplicates by source event ID;
6. sends unresolved or invalid events to a visible exception queue.
