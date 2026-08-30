# Finance Core Phase 5

## Purpose

Phase 5 introduces authoritative provider settlement reconciliation and carrier accounts payable. It closes the gap between operational payments/carrier bookings and accounting expenses without estimating costs from analytics or booking acknowledgements.

## Provider settlement workflow

1. Import a provider statement as a draft with payment, refund, fee, and adjustment lines.
2. The backend derives `net = payments - refunds - fees + adjustments` using exact decimals.
3. If the provider-reported net differs, import is rejected.
4. Payment and refund lines are matched to company-scoped payment intents/refunds by internal or provider reference.
5. Unmatched or mismatched payment/refund lines remain visible and block approval.
6. Finance may manually attach the correct payment intent/refund through the reconciliation endpoint.
7. Submit the reconciled statement for approval.
8. Approval records `payment:payment.provider_fee_recorded` when fees are positive.
9. The finance posting worker applies the active posting rule or creates an exception.

Fee and adjustment lines are statement-level lines and do not require payment matching. Raw provider credentials are never part of the finance document.

Endpoints:

- `GET /api/finance/provider-settlements`
- `POST /api/finance/provider-settlements`
- `GET /api/finance/provider-settlements/:id`
- `POST /api/finance/provider-settlements/:id/lines/:lineId/reconcile`
- `POST /api/finance/provider-settlements/:id/submit`
- `POST /api/finance/provider-settlements/:id/approve`
- `POST /api/finance/provider-settlements/:id/reject`

Permissions:

- `finance.settlements.read`
- `finance.settlements.manage`
- `finance.settlements.approve`

## Carrier payable workflow

1. Create a draft carrier bill against a company carrier provider.
2. Every bill line must reference an order and the exact booked `OrderLeg` assigned to that provider.
3. The backend derives line amount from quantity multiplied by unit price, then derives subtotal, tax, and total.
4. A supplier-reported total mismatch blocks creation.
5. Submit the bill for approval.
6. Approval records `carrier_cost:carrier.bill_approved` using the authoritative total.
7. The posting worker creates the payable/expense journal from the configured posting rule.

Endpoints:

- `GET /api/finance/carrier-bills`
- `POST /api/finance/carrier-bills`
- `GET /api/finance/carrier-bills/:id`
- `POST /api/finance/carrier-bills/:id/submit`
- `POST /api/finance/carrier-bills/:id/approve`
- `POST /api/finance/carrier-bills/:id/reject`

Permissions:

- `finance.payables.read`
- `finance.payables.manage`
- `finance.payables.approve`

## Controls

- IDs use database UUID v7 defaults.
- Company scope is enforced through the finance legal entity and owning-module reference services.
- Idempotency keys include a deterministic payload fingerprint; changed content returns a conflict.
- Foreign-currency documents require an FX timestamp.
- Workflow transitions and reconciliation changes create immutable finance audit events.
- Creator and approver separation is mandatory unless `policy.override` is explicitly present.
- Approval and source-event creation are one PostgreSQL transaction.

## Deployment

1. Apply migration `20260802160000_finance_settlements_payables` after Finance Phases 1-4.
2. Seed the six Phase 5 permissions.
3. Configure posting rules for `payment.provider_fee_recorded` and `carrier.bill_approved`.
4. Deploy the existing finance posting and finance outbox workers; no additional worker is required.
5. Import and reconcile a sandbox provider statement.
6. Create a carrier bill against a booked test leg.
7. Approve both with a second user, or use audited `policy.override` in a controlled test.
8. Confirm journals or inspect `/api/finance/exceptions` for missing setup.
