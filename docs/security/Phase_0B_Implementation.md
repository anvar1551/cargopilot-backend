# Phase 0B: order ownership and payment authority

Base: `4416941d2c56ecb3cd026bb49412d361d851b011`. This is a bounded containment milestone, not production readiness.

## Plan

1. Reject customer/address master references without an authoritative owner and reject caller financial state before mapping, imports or writes. Preserve snapshot-only orders with a freshly verified company membership.
2. Authorize payment against the order owner and current membership/scope. Use an issued invoice's exact stored Decimal amount, company and active FinanceLegalEntity; never fall back to client amounts or Float order totals. Validate provider context.
3. Reserve payment creation transactionally using the existing company/idempotency-key unique constraint and an order row lock. Matching requests reuse the durable result; conflicting or ambiguous attempts cannot trigger another provider operation.
4. Add focused mocked regression tests, run affected tests and no-emit TypeScript checking, and export the diff/new files for review. No services, migration, dependencies or generated output are touched.

## Schema boundaries identified before implementation

- Current compatibility behavior: Order.ownerOrgId and CompanyMembership can establish a company boundary for an order. They are not the target Tenant/TenantMembership model.
- CustomerEntity has no tenant/company owner; Address points to that unowned master. User.customerEntityId, memberships, selected company and historical order references cannot establish exclusive master ownership. Supplying these references or saving to the address book is rejected pending explicit ownership columns, authoritative backfill and tenant-matching foreign keys. Snapshot-only orders remain available. No positive owned-master test can honestly prove a relationship absent from this schema.
- Order has no durable request key/payload digest or unique tenant/request constraint. Idempotent order creation and whole-import atomicity remain blocked; payment-intent idempotency does not deduplicate orders.
- Invoice stores Decimal amount and company; Order.serviceCharge is Float, and mutable PricingComponent records do not provide an immutable approved payable snapshot. Immediate checkout of an unissued order is deferred until an authorized invoice is issued. Existing invoice production still needs pricing/rounding and workflow review; this phase consumes the exact issued value and does not certify its upstream calculation.
- PaymentIntent has a company/key unique constraint, but no legal-entity column or compound order/invoice/provider ownership foreign keys. Server-derived invoice/legal-entity bindings in metadata are compatibility enforcement, not structural tenant isolation. Crash recovery/reconciliation and database concurrency verification remain release gates.

## Implemented behavior and evidence level

**Current application enforcement (source and mocked tests):**

- JSON creation rejects supplied paid/status controls, root `amount`, `amountMinor`, caller `serviceCharge` and alternate nested/case/separator forms before Zod can strip them. Presence is rejected even for `null` or `NOT_PAID`. COD collection instructions (`codAmount`) and declared item value remain inputs; neither is used as online payment authority. New orders and cash collections start unpaid using server constants. The repository also rejects master references and non-default paid states before writes.
- JSON creation, CSV preview/confirm and repository creation reject customer/address master IDs and address-book save requests. The previous fallback from the global user's customer record is removed. CSV checks all rows before the first order write. Address snapshots and manual orders remain supported; CSV does not set an authoritative delivery price.
- Order ownership comes from a freshly queried active CompanyMembership on an active company organization, with a current compatible role permission and a company scope matching that company. Caller permission arrays are not trusted. Creation requires company scope because the present model cannot prove ownership for narrower customer/address references. Payment allows matching company scope or the order's current warehouse scope, always AND the verified owning company. Assigned-company access cannot authorize collection for a different owner.
- Online intent creation requires an issued invoice (or an already-paid invoice solely for matching reuse), matching order/company/customer references, issuance actor/time and an active FinanceLegalEntity belonging to that company. Decimal values convert exactly to BigInt minor units; unsupported currency, zero/negative amounts, fractional minor units and signed-BigInt overflow are rejected. Float order totals and client inputs are never fallback authority. Client company/amount/currency, if supplied, are equality assertions only; numeric JSON `amountMinor` is rejected to avoid pre-validation rounding. Use a decimal integer string on HTTP.
- An explicit enabled company payment policy, permitted provider and explicit server `PAYMENTS_ENVIRONMENT` are required. Config must match the owning company, provider and environment. Stripe credential prefixes must match the environment and its minor-unit input must be a safe integer. Current non-Stripe adapters lack a currency field and accept only UZS invoices in this flow. CLICK's checked-in adapter has a fixed endpoint; TEST use is rejected until a test endpoint contract is established. These checks do not verify merchant credentials, merchant legal ownership or deployed provider configuration.
- CLICK creation serializes exact major-unit digits in the numeric JSON amount without a Number conversion; it retains its AbortController timeout and requires an HTTP success with an invoice identifier. Stripe receives a stable company/intent idempotency key. No callback signature verification, callback handler, refund or settlement logic was changed.

**Durability implemented in source; PostgreSQL behavior unverified:**

Payment reservation uses the existing `PaymentIntent(companyId, idempotencyKey)` unique constraint. Within a bounded transaction it locks the owning order (`FOR UPDATE`), reads the invoice under `FOR SHARE`, validates authority and checks prior attempts before inserting. Lock/statement deadlines are 3/5 seconds; Prisma transaction max wait/timeout are 2/8 seconds. Only the successful reservation creator invokes the adapter, outside the transaction. A unique-conflict loser re-enters authorization and fingerprint checks once; it never blindly retries an external operation. Different keys for the same order are rejected if any prior intent exists, including legacy failures whose external outcome is not established. This intentionally requires reuse/reconciliation rather than assuming another charge is safe.

Matching requests return the stored result without business mutations, subject to current authorization and workflow eligibility. A cancelled/returned order or changed payment type cannot re-expose checkout through a matching key. Comparison covers order/company, invoice/legal entity, exact amount/currency and canonical request digests (provider selection, return URL, metadata). Optional legacy amount/company/currency assertions may be added or omitted if equal. Changing the request, invoice authority or reusing the key for another order gives 409. Legacy intents lack this binding and cannot be reused by this new path without reconciliation. Metadata stores server-generated bindings/digests; raw client metadata, provider responses and exceptions are not logged or retained by initiation.

A provider exception/timeout leaves the durable intent PENDING and records a generic ERROR attempt. This means **unknown initiation outcome**, not successful processing or confirmed payment. Same-key retry returns the pending record and a different key is rejected. A crash after reservation, or after provider acceptance but before result persistence, likewise requires reconciliation. No lease/outbox recovery worker was added. An initiation response cannot overwrite a callback that already advanced the intent: finalization is conditional on PENDING, and it never writes an older state onto the order. Order payment state now changes through authoritative settlement paths, not replay of an initiation result. External exactly-once processing is not claimed.

## API and consumer compatibility

This is a breaking containment change; the frontend repository was inspected at the relevant consumers but not modified or runtime-tested.

| Consumer / contract | Required change |
| --- | --- |
| `cargopilot-frontend/components/orders/CreateOrderDialog.tsx`, `steps/PaymentStep.tsx`, `steps/ShipmentStep.tsx`, `lib/orders.ts` | Omit paid/status controls even when null/NOT_PAID, root amount and serviceCharge. Do not supply customer/address master IDs or save-to-book requests. Render server pricing separately from submitted instructions. Customer-only master-linked workflows require ownership migration before restoration. |
| `BulkOrderImportDialog.tsx` and CSV APIs | Stop requiring/submitting customerEntityId. Use the updated CSV template; financial authority columns are rejected even when empty. Preview rejects forbidden headers/values before confirmation; whole-file atomicity and import idempotency remain open. |
| POST order creation with CARD/TRANSFER | Returns 201 with the created order, `paymentUrl: null`, `paymentPendingInvoice: true` and an invoice-required message. The existing active quote prerequisite is retained. After an authorized invoice is issued, call POST `/api/payments/intents` with orderId and a stable idempotencyKey. No automatic invoice issuance or provider charge occurs during creation. |
| POST `/api/payments/intents` | Required orderId and idempotencyKey; optional provider and legacy equality assertions companyId/amountMinor/currency. Extra authority fields are rejected. Send amountMinor as an integer string if retained. Return URL and JSON metadata participate in request identity; adapter redirect behavior remains existing server configuration. |
| `cargopilot-frontend/lib/paymentProviders.ts:retryOrderPayment` / POST `/api/orders/:orderId/payment/retry` | Retain the original key and original provider/returnUrl/metadata fields. The retry body now requires idempotencyKey and accepts the same optional fields as intent creation. It no longer generates a random key or copies an old amount. If a different intent already exists, reconciliation is required. |

Driver runtime behavior and other unavailable/uninspected consumers are unverified. No frontend, driver, worker or deployed configuration compatibility is claimed. Snapshot-only creation does not fix existing customer-workspace list/detail authorization, which still needs its own migration and negative tests.

Safe configuration illustration (documentation only, no environment file changed):

```dotenv
PAYMENTS_ENABLED=false
PAYMENTS_ENVIRONMENT=TEST
```

Enabling payments also requires an authorized, existing company policy/config and issued invoice/legal-entity data. No configuration rows, legal entities or invoices were created during this task. Merchant/account ownership must be verified separately; do not infer it from a credential prefix.

## Remaining release gates

Phase 0B is partial containment, **not production readiness**. All Phase 0A gates remain open, including Redis limiter lifecycle/backpressure and real Redis validation, existing role/scope escalation, complete tenant isolation, refresh/session/realtime consistency, bootstrap privilege seeding, dependency advisories and deployed infrastructure/consumer assurance. The supplied Phase 0A source review and external Redis harness were reused; no harness or full audit was repeated.

Specific outstanding requirements:

1. Add authoritative tenant ownership to CustomerEntity and its addresses, backfill from verified business evidence (no default tenant), then enforce tenant-matching foreign keys and negative tests. CompanyMembership remains compatibility behavior, not the target tenant model.
2. Order-level durable tenant/key uniqueness plus a payload binding is required to deduplicate order/CSV requests. The current order counter/referenceId is insufficient. Existing multi-step pricing, carrier/label effects and partial-import recovery remain outside this phase.
3. Establish an immutable approved payable/invoice lifecycle, exact upstream tariff/invoice calculations, and explicit invoice/order/legal-entity/provider compound constraints. FinanceLegalEntity.companyId currently provides only a one-company/one-profile compatibility mapping; historical legal-entity reassignment is not solved by metadata.
4. Real PostgreSQL tests must verify applied uniqueness, same-key/different-order races, different-key/same-order locking, lock deadlines, rollback and callback races. Simulated mocks establish control flow only. No migrations or database operations were executed.
5. Durable dispatch recovery and provider reconciliation must cover reserved-but-not-sent, sent-but-unrecorded and confirmed-cancel/retry cases before automatic redispatch can be enabled. Provider merchant ownership, supported currencies/environments, idempotency guarantees and end-to-end acceptance remain unverified.
6. Existing provider callbacks/refunds/financial workflows, sensitive webhook-header retention, non-atomic integration acceptance and recovery, callback resource controls and amount/currency reconciliation findings remain unresolved. This phase does not certify payment settlement or fix role/scope grants that could undermine current membership permissions.

Rollback requires deliberate source review: reverting these guards reopens the documented vulnerabilities. There is no schema migration in this diff. Preserved dist is not a verified deployment artifact.

## Validation

All regression execution uses in-process database/provider/label/carrier substitutes. During implementation and validation, no database, Redis, AWS or provider connection, image pull, migration, seed, dependency change, stage, commit, push or deployment was performed.

Executed in the repository using installed tooling on 2026-09-06:

1. `.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/orderRepo.test.ts tests/security/order-creation-authority.test.ts tests/security/payment-authority.test.ts`
   - Exit 1; 78 passed, 1 failed, 3 suites, 40.678 seconds. The failure exposed Decimal positive-zero handling. Replaced `isPositive()` with an explicit `lte(0)` rejection.
   - The 33 order tests in the two passing order suites are retained: their source/tests did not change afterward.
2. `.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/payment-authority.test.ts tests/security/payment-provider-creation.test.ts`
   - Exit 0; 50/50 passed, 2/2 suites, 24.340 seconds. This includes four adapter tests with fetch/Stripe replaced in process. Provider adapter source/tests did not change afterward; those four results are retained.
3. Final review added cancellation/return checks before matching reuse and two regression cases. Ran only the affected suite:
   `.\node_modules\.bin\jest.cmd --runInBand --detectOpenHandles --runTestsByPath tests/security/payment-authority.test.ts`
   - Exit 0; 48/48 passed, 1/1 suite, 22.096 seconds. No snapshots or open-handle warning.
4. `.\node_modules\.bin\tsc.cmd --noEmit --pretty false`
   - Final source/test check: exit 0, no diagnostics. Earlier intermediate no-emit checks also exited 0. No source/test changes followed the final check; subsequent edits only document the results.
5. `git -c core.safecrlf=false diff --check -- . ':!dist'`
   - Exit 0, no whitespace errors. New files were checked separately for trailing whitespace. A targeted high-confidence credential scan found no matches, and the focused diff/new files were reviewed for scope and sensitive values. Fixture credentials are inert test strings. This is not a general secret-scanning certification.

**Final retained evidence: 85 distinct passing tests across four affected suites**, assembled from the runs above, not a claimed single 85-test run. Unchanged Phase 0A tests were not repeated. PostgreSQL uniqueness/locking/concurrency and all real-provider/infrastructure behavior remain unexecuted and unverified. No build emitted files; dist and unrelated work were preserved. No dependency, Prisma schema or migration file changed. The review export includes the focused tracked diff, full new files and a file hash manifest outside the repository.

## Local containment commit

The user subsequently authorized one local commit of the reviewed Phase 0B changes. All 19 reviewed files initially matched the external review's SHA-256 manifest. Staged whitespace checking then found one extra blank line at EOF in `creation-authority.ts`, which was removed; installed TypeScript produced byte-identical transpilation before and after that whitespace-only edit. Source behavior and tests are unchanged, so the recorded validation is reused without rerunning tests or type checking. Apart from that EOF cleanup and this documentation update, the commit matches the reviewed source, test and documentation paths. Staged-diff, whitespace and targeted secret checks cover the exact commit contents. Dist, private files, external exports and unrelated changes are excluded.

This commit retains customer/address master rejection, company-scope-only order creation and invoice-required checkout with the documented frontend incompatibilities. Order/import idempotency, PostgreSQL locking/concurrency verification, durable provider recovery and every previously recorded release blocker remain outstanding. No push, deployment, service connection or migration is part of this local milestone.
