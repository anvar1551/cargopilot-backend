# Invoice issuance containment

Baseline: e05dc7d8cb178797a020dd7eb4415c46d744db66. This slice does not certify authoritative pricing or restore new invoice issuance.

## Plan and source findings

Use fresh selected membership/permission and parent-order scopes, constrain the selected owning company, serialize the parent order, preserve an already issued receipt, and reject absent financial acceptance before writes. Existing nullable ownership is not backfilled. No migration is needed for this containment; existing populated invoice/order compound relationships and unique orderId remain in place.

The sole issuance caller is the invoice POST route. Pricing components can be inserted through the order pricing route with caller-supplied amount, FX, source and referenceKey under shipment.update; markers such as rule/system are forgeable. Normal creation/import seeds originate from server quotes but use numbers/Float and best-effort persistence without a durable approved exact pricing acceptance. resolvePayableTotalFromPricing sums Decimals through JavaScript numbers; its absence of FX was previously replaced with 1. The generic finance consumer resolves committed outbox records but does not establish invoice-specific execution authority, and normalizeFinanceSourceEvent rounds FX to four decimals. Cash-specific worker protections do not certify this invoice path.

## Current enforced behavior and compatibility

- All issuance calls require a fresh full selected context, finance.invoices.issue, the existing object scope and matching order tenant/owning company. The current owned financial legal entity must exist and be active. Tenant equality never replaces company/object restrictions.
- The transaction uses an order FOR UPDATE lock and invoice FOR SHARE, with 3-second lock wait, 5-second statement deadline and 10-second transaction deadline. Current ownership/customer relationships are checked after locking. No network operation occurs inside it.
- Owned issued/paid records with issuance evidence and finite positive exact amount/FX return an immutable safe receipt. Decimal values are projected directly as strings; existing receipt money/FX is preserved, not newly certified as approved pricing. Each retry still requires current authorization.
- An explicit changed due date conflicts (409); omitted dueAt preserves the stored receipt. HTTP and direct service input allowlists reject ownership, monetary and status fields. The route preserves omission instead of converting it into an explicit null.
- New/missing/pending or inaccessible legacy unowned issuance fails closed with 409; no ownership assignment, invoice mutation, storage, provider request or financial outbox event occurs. Cancelled/credited records cannot be reissued. Existing invoice reads/checkout remain available under their existing protections; this is an explicit incompatibility for new issuance/checkout requiring a new invoice.
- Fresh authorization precedes lock acquisition; concurrent status/permission changes after that check remain a timing boundary. Locks cover only this issuer/receipt path, not all pricing/finance writers. Rollback must retain containment or disable issuance; never restore unscoped or guessed pricing.

## Decisions and next implementation

Required approved decision: which pricing adjustments are financially authorized, who may approve them and what stored evidence establishes acceptance; FX source, effective time, base/legal-entity currency, precision and rounding policy. Do not treat shipment.update or a caller source marker as pricing authority. Engineering prerequisite: durable exact accepted pricing snapshot bound to order/tenant/company/legal entity, populated only by verified server calculation or explicitly approved adjustments, then transactional unique issuance and invoice-specific finance execution authority. Do not invent account mappings or conversion policy.

## Validation

52 mocked cases passed across invoice-issuance-containment (24 new) and invoice-read-containment (28 affected, including updated receipt projection). Initial run exposed positive-zero Decimal behavior (51 passed/1 failed); finite gt(0) correction made the final 52 pass. These are not PostgreSQL/transport evidence. Jest reported a delayed-exit warning but exited successfully; lifecycle investigation remains separate.

Executed: node node_modules/jest/bin/jest.js --runInBand tests/security/invoice-issuance-containment.test.ts tests/security/invoice-read-containment.test.ts (52 passed); node node_modules/typescript/bin/tsc --noEmit (passed after the final source correction).

Executed: node "$env:TEMP/cp-invoice-disposable-run.cjs", adapted from the existing support runner, targeting tests/security/invoice-issuance-postgres.integration.test.ts. Full 72 committed migrations applied without replacement schema/db push. Eight distinct PostgreSQL cases passed in one run: concurrent immutable receipt access, foreign company, foreign tenant, competing unaccepted pending issuance, legacy null invoice, conflicting due date, suspended membership, and injected read-transaction failure followed by successful lock reuse. The last case proves abort/lock release and unchanged records, not rollback of a newly issued financial write, which remains contained. No new issuance or posting concurrency claim.

Run db476d6b4ff9 used a new cp-invoice-ownership-db476d6b4ff9 container, cached PostgreSQL 16 Alpine image with --pull never, loopback-only random port, synthetic credentials, 512 MiB memory, one CPU, 128 PIDs and exclusively owned 256 MiB tmpfs. The runner uses an allowlisted environment without existing database endpoints; URL/run-marker guards, bounded connections/statements and test deadline remain intact. Cleanup verified exact container identity/run label and no volumes/bind mounts before removing this container and its tmpfs. Existing containers and services were not accessed. Migration identifier truncation notices are pre-existing; no migrations were edited. No schema changes, client generation, dependency changes or preserved dist changes.

## Remaining release gates

Approved exact pricing/FX acceptance and new issuance remain blocked, not completed. General invoice finance ingestion/posting authority, existing checkout gaps, legacy Float migration, posted immutability outside covered paths, provider recovery, tenant-null cutover, distributed revocation/Redis lifecycle, order/import idempotency, client/device/storage verification, delegation/provisioning and RLS remain open. No complete isolation or production readiness claim.
