# DOM-06 — exact monetary basis and connected cash journey

Planning baseline: `cb32e6f5b96d52a043ada9f8f8397cae0713fd33`.
Status: approved historical plan. The service-charge implementation and exact
evidence are recorded in [Exact_Service_Cash_Workflow.md](Exact_Service_Cash_Workflow.md).
The original inspection/proposals below describe the planning baseline; merchant
COD remains proposed and unavailable. DOM-05 synthetic-obligation prerequisites
are superseded only by the tested DOM-06 normal-service journey.
Owner approval resolved historical questions 1 and 2 below, including pending/uncertain
payment freezes. Question 3 (merchant COD) remains unresolved and unimplemented.

## Verified current source and missing invariant

| Path | Current enforced behavior | Gap relevant to DOM-06 |
| --- | --- | --- |
| Normal/import creation: orders-core/write/create-order.ts, repo/order-write.repo.ts, import/order-import.ts | Selected-company creation authority, master-reference checks and durable context/row receipts. Server quote may seed serviceCharge; creation rejects supplied serviceCharge/paid fields. Import commits rows independently, skips completed rows on matching retry and does not replay downstream work. | creation-authority.ts permits legacy codAmount/payment instructions; mapper defaults CASH/SENDER. collection.shared.ts can create expected Float rows from these creation values. Neither quote nor legacy row is accepted selling-price or merchant authority. |
| Payer: pricing-core/repo/order-price.ts::bindOrderBillTo | billing.payers.bind, current accepted financial capability/entity and customer/object checks; immutable per-order payer/evidence with operation identity. | OrderBillTo does not bind payment method or collection party/timing. Existing order CASH/SENDER/RECIPIENT fields are requests/defaults, not independently accepted financial instructions. A bill-to customer need not be the physical recipient or merchant. |
| Price: order-price.ts::acceptSnapshot | Exact immutable approved snapshot, independent exceptions/revisions, order lock and conditional current pointer; source tariff/policy/payer/context links. Existing invoice prevents revision. | Does not create an exact obligation; currently lacks a cash-collection/payment fence on later price acceptance. |
| Restricted cash: cash/restricted-cash.service.ts | Current accepted supplemental capability, exact accepted service price/payer/entity, current assignment/holder/warehouse, event locks/receipts; COD rejects. Float rows may reject disagreement but never set accepted amount. Offers retain origin custody until acceptance. | Collection requires existing matching expectedAmount/serviceCharge mirrors. RestrictedCashState is exact but first created only upon collection; there is no authoritative exact expected obligation before that. |
| Pickup/delivery: operations/order-status.ts and warehouse-custody.ts | Existing sender pickup and recipient/COD delivery cash guards, parent locks, parcel/custody and actor checks. | Cash-due detection still consumes Float rows/mirrors. New obligations must drive guarded timing so missing/stale initialization cannot permit pickup/delivery. Preserve conservative legacy blocking; do not fabricate a legacy obligation. |
| Manual invoice: invoice-core/application/accepted-issuance.ts | Exact current approval/payer/entity and eligible approved policy state, same-base currency, protected receipt/number/audit/held fact. | Issuance is not a payment receipt. Cash custody settlement must not set invoice paid or enable accounting. Ensure frozen obligation and invoice refer to the same accepted service basis. |
| Online payments: payments-core/application/payment-creation.ts and payment-webhook.ts | Typed invoice-bound reservations, exact amount/currency/authentication, parent locking/deduplication; verified callbacks require CARD/TRANSFER. | No new payment-mode conversion or allocation/reconciliation contract. DOM-06 cash must deny overlapping paid/pending/uncertain financial sources instead of guessing that an obligation is unpaid. |

These are repository facts, not claims about existing database contents.
Merchant goods money never enters company service-price components or service invoices.

## Proposed smallest implementation (service charge first)

1. Add an immutable `OrderServicePaymentInstruction` in the billing model, bound
   by compound FKs to exact tenant/company/entity/order/OrderBillTo/payer and
   selected actor membership. One instruction per order; context/operation unique,
   normalized fingerprint, bounded evidence/reason, authoritative time and protected
   audit. No amount, paid flag, tenant/entity or arbitrary currency request fields.
   Proposed additive `POST /api/orders/:id/service-payment-instruction` body:
   `{operationId, billToId, method:"CASH", collectionParty:"SENDER"|"RECIPIENT",
   evidence, reason}`. Existing accepted billing-operator.v1 + billing.payers.bind
   and current company/customer/object controls; not permission-by-role-name.
   **This use of that grant and collection-party policy needs owner approval below.**
   Bind before first price acceptance; no change/adoption after acceptance, invoicing
   or payment activity. Existing bill-to and price APIs remain available without an
   instruction, but must not thereby create collectible cash. CARD/TRANSFER/COMPANY/
   OTHER and payment-mode changes are outside this cash initializer.

2. Add immutable `OrderCashObligationVersion` exact Decimal(20,4) amount/currency,
   service_charge kind, instruction, approval, bill-to/payer and authoritative
   tenant/company/legal entity. Use existing supported-currency precision contract;
   no inferred rounding/FX. Compound source FK includes accepted amount/currency/
   payer; unique accepted approval/kind ensures one derived fact. An owned per-order/
   kind current pointer links the active version and compatibility collection ID.
   Version includes previous-version link and accepted operation provenance; protected
   UPDATE/DELETE/TRUNCATE evidence. Collection/custody exact records must link this
   basis, not just a caller ID or Float. Add suitable compound targets and constraints
   through a new migration; no rewriting published migrations or historical records.

3. Derive the obligation in `acceptSnapshot` inside its existing acceptance
   transaction when the explicit approved CASH instruction exists. Standard acceptance
   and independent revision approval share this helper. Approval + exact obligation +
   pointer + necessary compatibility mirrors + audit commit together. No initialization
   endpoint, worker, direct insert or post-commit best-effort seeding. Stop Float-based
   initial collectible-row seeding in the compatible normal/import creation writer;
   creation quotes stay estimates, not obligations. Positive first acceptance inserts
   its expected CashCollection compatibility row linked to the exact version. Zero
   approved price is recorded as noncollectible, not invented positive cash. Preserve
   existing legacy expected rows/events as untrusted history: if the unique order/kind
   slot is already occupied without a proven new obligation link, reject initialization
   with a reconciliation code rather than adopt, delete or overwrite it. Revisions
   may update only the mirror already linked by this new service, under its locks,
   while preserving immutable exact versions and expected-change evidence. No
   historical backfill or workaround to existing order/kind uniqueness.

4. Restricted reads/collection consume the current exact obligation and explicit
   instructions, verify source hash/approval/entity/payer/context and matching kind;
   confirmed custody retains its original immutable obligation. Decimal values never
   round-trip through Number for authority. Keep Float columns only as deliberately
   validated compatibility projections; migrate cash-due guards to exact basis for
   new records. If a value cannot be safely mirrored, reject the compatibility path
   explicitly rather than round it; do not change global legacy Float schemas here.
   Add current exact obligation IDs/kind/decimal state to narrow preflight; expose no
   credentials or broad orders. No supplemental capability or driver base expansion.

## Timing, revisions, payments and operation identities

- Proposed SENDER cash is due before picked_up; RECIPIENT before final delivered.
  Existing approved warehouse collection remains available within its existing
  guarded states, e.g. recipient charge collected at warehouse on payer's behalf;
  a caller cannot move the instruction or stage by altering order fields.
  A new instruction with unaccepted/missing/stale basis blocks its applicable
  transition rather than treating missing money as zero. Free-text/noncash creation
  remains available; it does not acquire guessed approved cash instructions.
- Before any collection/payment/invoice, an independently accepted price revision
  can atomically supersede an uncollected expected obligation, preserving earlier
  versions, receipts and expected history. A proposal alone cannot change money.
  Stale collection versus revision serializes on the owned Order and current pointer.
- After collection (including settled custody), any pending/successful/uncertain
  payment source, or invoice issuance, reject amount/currency/payer/instruction
  changes. No refund, additional collection, cancellation, credit/reissue or
  partial-payment policy is invented. Legacy PAID/PARTIAL, holder/event conflicts
  or payment sources without proven allocation stay blocked for reconciliation.
- Acceptance's existing operation identity supplies the derivation identity;
  unique approval/kind plus conditional pointer prevents duplicate versions. Matching
  authorized retries return original historical acceptance/basis, never republish a
  superseded pointer. Different normalized content/context rejects. Existing import
  identity stays bound to original normalized row instructions; acceptance is a
  separate explicit action per committed order, not authority hidden inside import.
- Reuse billing/financial reference-pin and restricted cash participant locks;
  acquire accepted authority before domain/order locks, then obligation/collection
  locks. Review complete sequence against revoke, invoice and callback paths;
  no new order-first membership acquisition. Bound lock/statement/transaction time,
  no network inside transactions. Competing schedules must be demonstrated, not
  inferred safe from transactions alone.

## Proposed merchant COD provenance (separate, not enabled)

Require an independently addressable immutable merchant instruction: verified
merchant/beneficiary CustomerEntity, external source reference/version, owned order,
exact decimal goods amount/currency, stated physical payer, goods-only purpose,
bounded evidence reference + content digest, accepting staff membership and time,
stable operation ID/fingerprint. Do not persist arbitrary private goods payloads.
Company/entity identifies the accountable custodian; it does not turn merchant
money into company revenue. Customer ownership/UUID/ordinary shipment.create do
not prove merchant authority; a manual assertion is not a verified merchant contract.

Proposed first contract is a per-order declaration from an explicitly verified
merchant representative/source with explicit beneficiary and authorized company
acceptance; no live integration needed in the service-charge batch. Source identity
binding, permitted staff approvers, amendment/cancellation and collectible timing
must be approved before a COD initializer or new grant is exposed. No code should
adopt Order.codAmount/itemValue/referenceId as provenance. Retain the legacy request
only as non-authoritative input and block collection; guard unresolved COD orders
from appearing safely deliverable. Existing service-only RestrictedCashState price
link is intentionally not overloaded for COD. A later typed merchant source link
must make service and goods obligations/results distinguishable end-to-end.

## Connected acceptance and focused evidence

Use one uniquely owned disposable PostgreSQL instance after the final schema is
ready, full committed migration chain, synthetic test-only permits and no existing
services. Reuse DOM-04 appointment/onboarding and DOM-01/02/03/05 normal entrypoints:

1. Owner-controlled onboarding -> invitation/credential enrollment/selected login ->
   appointed company setup proposer/checker -> independent entity publication.
2. Explicit warehouse provisioning/ceilings; operational staff/dispatcher and exact
   local/linehaul driver enrollment; independent financial and supplemental cash
   actor grants. No seeded issuing entity, obligation, cash state or managed grant.
3. Actual scoped customer/addresses, independently approved synthetic tariff/policy
   with explicit currency/state eligibility -> normal durable order creation ->
   bill-to -> explicit proposed CASH/SENDER instruction -> exact standard acceptance.
4. Authorized dispatcher assignment -> restricted initial driver cash collection
   before picked_up -> pickup/handover -> parcel intake clears assignment **without
   cash movement** -> driver's cash offer -> exact warehouse recipient acceptance ->
   separate checker settlement. Exercise existing linehaul/last-mile/durable PNG
   proof workflow only to reach configured invoice state; reuse detailed unchanged
   logistics tests rather than starting another broad campaign.
5. Issue same-base-currency manual invoice from the same accepted service amount;
   prove cash settlement does not auto-mark it paid. No accounting/provider execution.
6. Retry create/import-row, instruction, price acceptance, collection, offer,
   acceptance, settlement and issuance with their original IDs; assert original
   results, exact service amount and one business fact per intended operation.
   Mock storage/labels/queues explicitly; local sockets/IAM evidence reused unless
   source changes. No claim of S3/device/provider transport or external exactly-once.

Additional affected cases: foreign tenant/entity/payer, wrong customer/address,
missing accepted actor/instruction/basis, manipulated money, COD rejection and
legacy Float conflict; zero/supported precision; authorized uncollected revision,
post-collection/post-payment/post-invoice rejection; simultaneous acceptance and
collection/revision/invoice/revoke; duplicate initialize/collect; injected failure
after approval/obligation/audit/mirror writes and lost-ack matching retry. Assert
full graph and held outbox/audit business invariants, not just HTTP codes. Include
normal import row replay/partial-success preservation. No direct prerequisite cash
insert in the connected test. Check constraint insert/update and append-only
protection; verify disposable ownership/cleanup. Final no-emit/offline schema;
only affected unit/HTTP cases. Reuse unchanged 17-case DOM-05 and IAM/logistics/
invoice evidence where exercised code, schema and configuration actually remain
unchanged; old cash-producer tests are not newly restored evidence.

## Milestones, rollout and exact completion criteria

1. Approved instruction/revision policy -> additive service basis models/migration
   and atomic normal acceptance wiring. Review source/FKs and focused tests.
2. Restricted exact consumption/timing guards and actual connected PG journey;
   contract conflict/concurrency/rollback cases, schema/no-emit, cleanup and local
   coherent implementation checkpoint only when subsequently authorized.
3. Readiness report distinguishes restored service cash from blocked merchant COD,
   invoice paid/reconciliation, accounting/FX and external/client gates.

Done means no direct obligation/custody prerequisite inserts, one exact service
basis across acceptance/collection/transfers/settlement/invoice, no supersession after
collection, retries without duplication, rejected writes unchanged and stated actual
PostgreSQL evidence. Merchant COD is not a completion requirement for the service
milestone and remains visibly unavailable. No new executable finance publisher.

Deploy schema before compatible price/cash/status writers; stop incompatible old
cash/pricing writers. Legacy source links stay untrusted/null and inaccessible for
new collection; no automatic adoption. Rollback preserves enforcement or disables
affected operations. Later clients need explicit payment instruction/current basis
handling; do not silently change immutable queued intents or legacy receipts.
No client implementation, migration execution, test reruns, commit or deployment
performed during this planning task.

## Consolidated material approval questions

1. May an accepted billing-operator.v1 using billing.payers.bind explicitly bind
   CASH and SENDER/RECIPIENT collection on behalf of the recorded bill-to customer,
   before first price acceptance, with evidence/reason? Proposal: separate additive
   instruction endpoint, no inferred defaults and no COMPANY/OTHER/online conversion.
2. Approve automatic service-obligation publication with accepted price, reasoned
   independent supersession only while uncollected and with no financial activity,
   and freezing basis after any collection/payment activity or invoice? Proposal:
   sender due before picked_up, recipient before delivered, zero is noncollectible;
   later adjustments remain unavailable rather than inventing refunds/allocations.
3. For merchant COD, who can prove the merchant request and beneficiary, and who
   may accept/amend it within the company? Approve a verified merchant identity/
   source-binding contract and goods-only declaration before enabling COD. Until
   then implement only service-charge work in a later approved batch; no new COD
   permission, obligation or merchant payout policy is inferred.
