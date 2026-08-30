# Finance Core Phase 7

## Purpose

Phase 7 adds treasury controls, supplier payment runs, payable allocations, and bank-statement reconciliation. It provides a controlled path from an approved supplier liability to a posted bank payment and a reconciled bank statement.

PostgreSQL remains authoritative. Redis and analytics must not execute, approve, allocate, or reconcile money.

## Supplier payment lifecycle

1. Finance creates a company-scoped bank account. Only a SHA-256 identifier hash and masked suffix are persisted or returned.
2. Finance selects open carrier payables and creates a draft payment run.
3. The transaction reserves each selected payable balance. Concurrent runs cannot over-reserve the same payable.
4. The maker submits the run.
5. A different user approves or rejects it.
6. A third operator records execution with the bank reference and execution timestamp.
7. Execution creates one immutable `payable:payable.payment_executed` source event per run line.
8. The existing finance posting worker posts the configured journal and creates the payable allocation in the same database transaction.

Required posting rule for `payable.payment_executed`:

- debit Accounts payable (`2100`) using `payable_amount`
- credit Bank accounts (`1120`) using `payable_amount`

The payment-run executor records a bank-confirmed or manually verified transfer. Direct bank API initiation can be added later through integrations-core without changing the accounting contract.

## Segregation of duties

- Creator and approver must differ.
- Executor must differ from creator and approver.
- `policy.override` permits an emergency exception, but the actor and action remain audited.
- Preparation, approval, and execution use separate permissions.

## Bank statements

Imported statements must satisfy exactly:

`opening balance + credits - debits = closing balance`

External transaction IDs are unique per bank account across all statement imports. A statement line can be:

- matched to one executed supplier payment run for an exact bank debit; or
- matched to one approved provider settlement for an exact bank credit; or
- explicitly ignored with a mandatory reason.

Only fully handled statements can be submitted. A different user approves the submitted statement. Reconciliation proves existing treasury and settlement records; it does not create duplicate accounting journals.

## Endpoints

Bank accounts:

- `GET /api/finance/bank-accounts`
- `POST /api/finance/bank-accounts`
- `PATCH /api/finance/bank-accounts/:id/status`

Payment runs:

- `GET /api/finance/payment-runs`
- `POST /api/finance/payment-runs`
- `GET /api/finance/payment-runs/:id`
- `POST /api/finance/payment-runs/:id/submit`
- `POST /api/finance/payment-runs/:id/approve`
- `POST /api/finance/payment-runs/:id/reject`
- `POST /api/finance/payment-runs/:id/execute`

Bank reconciliation:

- `GET /api/finance/bank-statements`
- `POST /api/finance/bank-statements`
- `GET /api/finance/bank-statements/:id`
- `POST /api/finance/bank-statements/:id/lines/:lineId/reconcile`
- `POST /api/finance/bank-statements/:id/lines/:lineId/ignore`
- `POST /api/finance/bank-statements/:id/submit`
- `POST /api/finance/bank-statements/:id/approve`
- `POST /api/finance/bank-statements/:id/reject`

All list endpoints are cursor paginated and company scoped.

## Permissions

- `finance.treasury.read`
- `finance.treasury.manage`
- `finance.treasury.approve`
- `finance.treasury.execute`
- `finance.bankReconciliation.read`
- `finance.bankReconciliation.manage`
- `finance.bankReconciliation.approve`

## Idempotency and audit

- Bank accounts, payment runs, and statements require company-scoped idempotency keys.
- Reusing a key with different authoritative contents is rejected.
- Payment execution is idempotent per run line and canonical source event.
- Payable allocations have unique source-event and payment-run-line constraints.
- Creation, workflow transitions, execution, matching, ignore decisions, and approval are written to `FinanceAuditEvent`.

## Deployment

1. Apply migration `20260802180000_finance_treasury` after Phase 6.
2. Run the permission seed so the new permission catalog is synchronized.
3. Configure and activate the `payable.payment_executed` posting rule for each legal entity.
4. Keep the existing finance posting and finance outbox workers running; Phase 7 adds no polling worker.
5. Create a sandbox bank account and partial supplier payment run.
6. Verify the journal, payable allocation, current AP aging, and historical AP aging.
7. Import a balancing statement and reconcile the payment-run debit before approval.

Do not apply the migration until the deployment database and backup plan have been confirmed.
