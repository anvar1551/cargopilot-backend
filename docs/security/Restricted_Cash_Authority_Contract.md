# DOM-05 — restricted cash authority

Approved baseline: `5a83c48852bff9e1ea53c713b021e26929c7f6f1`.
Owner approved the three narrow profiles, separate company/entity/resource-bound
cash delegation, explicit offer/acceptance and warehouse-only settlement. This
batch does not approve COD provenance, accounting, FX or suspended-holder recovery.
Implementation has focused validation below; this is not a production-readiness claim.

## Exact capability and authority contracts

| Immutable revision | Exact permission keys | Enforced boundary |
| --- | --- | --- |
| local-driver-cash.v1 | cash.custody.read, cash.collect, cash.handoff | Current accepted local DOM-01 membership with unchanged exact base role and zero scopes. Collect only its authoritative initial pickup assignment or accepted last-mile custody. Handoff only its exact durable cash holding, including after parcel intake removes assignment. Warehouse IDs are cash destination ceilings, never warehouse scopes. |
| warehouse-cash.v1 | cash.custody.read, cash.collect, cash.handoff | Current accepted operational warehouse profile, explicit base warehouse scopes intersected with accepted cash ceilings. Collect at current warehouse; exact named cash holder offers transfers. |
| cash-settlement-checker.v1 | cash.custody.read, cash.settle | Owned selected company/legal entity, explicit source warehouse ceiling; warehouse-held only. Different User from original collector, latest custody maker and recorded human holder. No general shipment or accounting access. |

Cash supplements live separately from roles, token claims and scopes. Each cash
service reloads its current accepted record from PostgreSQL. HTTP authenticates
selected sessions and the service enforces the action capability. Raw permission
possession, role names, User.driverType/warehouseId and JWT flags are insufficient.
No shipment.view/update/assignCourier, scope, platform, finance execution or
further delegation is added to driver/warehouse base profiles.

Controlled `authorizeCashCapabilityDelegator` has no HTTP or signing endpoint.
Existing owner Ed25519 permit verification uses `cash-delegation.v1`; an explicitly
provisioned registry must approve that revision. Intent binds operationId, exact
membership/User/tenant/company/TenantMembership, active legalEntityId, proposer or
checker kind, profile revisions, cash kinds, sorted nonempty warehouse IDs and
bounded reason. Owner appointment adds only membership.proposeCashCapability or
membership.approveCashCapability to a non-platform company-scoped administrator.
No existing onboarding/operational/financial authority is silently expanded.

Routine HTTP under /api/auth:
- POST /company-cash-capabilities/proposals: operationId, membershipId,
  legalEntityId, profileRevisions (exactly one), warehouseIds, kinds,
  expectedAcceptanceId (null for first grant), reason.
- POST /company-cash-capabilities/accept: operationId, proposalId, fingerprint,
  reason. Checker differs by User from proposer AND recipient.
- POST /company-cash-capabilities/revoke: operationId, membershipId,
  legalEntityId, expectedAcceptanceId, reason. Either accepted authority with the
  entire removal ceiling may revoke; reinstatement needs independent acceptance.

Proposer cannot self-target. Current maker/checker ceilings cover removed and
replacement profiles/entity/resources/kinds; partial ceilings cannot be combined.
Independent normalized proposals/actions and compound ownership constraints bind
accepted grants. Grant/audit/version/context-session changes commit or roll back
together; unrelated roles/scopes/company memberships remain. Revoking an authority
blocks pending/new decisions but does not silently revoke existing recipient grants.
Protected journals reject UPDATE, DELETE and TRUNCATE. Database-owner/schema-admin
powers are outside application-level tamper protection.

## Cash HTTP and custody contract

POST /api/orders/:id/cash/collect: operationId, kind, optional note/warehouseId.
POST /api/orders/:id/cash/handoff: operationId, kind, expectedEventId,
recipientMembershipId, recipientWarehouseId (warehouse UUID or explicit null), note.
This now creates an OFFER and does not move custody.
POST /api/orders/:id/cash/handoff/accept: operationId, kind, expectedEventId,
offerId, optional note. Only the exact recipient membership can accept.
POST /api/orders/:id/cash/settle: operationId, kind, expectedEventId, optional note.

Strict fields reject monetary/paid/ownership authority and legacy User-only targets.
Every action uses an immutable 8–100-character operation ID and normalized context
fingerprint. Fresh current capabilities precede returning a stored receipt; matching
retry returns original minimal result, conflicting reuse rejects. Retries retain
original source/offer/state identities, never silently replace an ambiguous intent.
Response stays {success:true, order:<minimal cash result>}; amounts are decimal
strings, expectedEventId is authoritative. Settled results have no current holder.

Bulk collect/handoff/settle retain per-item partial success (207 on any rejection),
max100 independently committed items, each with its own operationId. Handoff is
an offer; there is no implicit acceptance or whole-batch atomicity.
GET /api/orders/cash/queue takes limit1–50 (default25), context-bound cursor.
GET /api/orders/:id/cash/preflight returns the same minimal one-order page.
No credentials, emails, full orders or general company cash projections. Legacy
unproved held cash is hidden. Numeric/mixed-currency queue-summary returns
CASH_EXACT_SUMMARY_UNAVAILABLE; legacy filter/page contracts fail closed.

Driver -> approved warehouse requires destination/origin evidence in the owned
order's immutable pickup/warehouse/transport/last-mile history and recipient's
accepted warehouse capability/scope. The parcel driver need not be the cash holder;
later assignment/movement cannot erase the original holder's authorized handoff. Warehouse -> driver requires accepted last-mile custody at that
warehouse, exact local membership, active cash capability and current assignment.
Nomination alone is insufficient. No warehouse-to-warehouse or linehaul transfer.
Originating membership retains money until recipient acceptance commits. Physical
intake/assignment/delivery never changes cash holder. A revoked/suspended cash holder
cannot act or be used for an accepted transfer/settlement; no physical-receipt
recovery privilege is borrowed for cash.

New RestrictedCashState binds exact collection/order/tenant/company/entity, accepted
price, decimal amount/currency, holder membership/User/warehouse and custody event.
Compound FKs bind ownership and money; financial basis cannot be rewritten. Offers
and execution receipts are append-only; one offer per source state and one accepted
result per offer. Old held cash is not adopted/backfilled from current assignment.

## Monetary and financial boundaries

Only positive, exact accepted service-price approval + bill-to + active same-base-
currency entity can supply new service collection authority. Legacy Float mirrors
can only reject inconsistency; they never supply amount. Expected obligation must
already exist and exactly agree. Normal current price acceptance does NOT initialize
these mirrors/expected cash: that is a confirmed DOM-06 prerequisite, not restored
end-to-end cash readiness. Tests explicitly label synthetic compatibility obligation
fixtures derived from a real accepted exact price; they are not production backfill.
Merchant COD collection rejects CASH_MERCHANT_BASIS_UNAVAILABLE pending provenance.
No obligation generation/revision, inferred payout, FX, refunds or accounting rule.

New restricted execution publishes committed analytics references only. Its protected
exact receipts remain HELD financial evidence; it does not publish executable finance
source facts. DOM-06 must define/implement service/COD source binding and reconciliation
before finance ingestion for these new actions. Existing approved cash-finance evidence
is not evidence that this new receipt variant posts. Collection marks the service paid
mirror; settlement advances custody to finance, not invoice/merchant/ledger settlement.

## Locks, rollout and evidence

Execution discovers participant identities only as hints; sorted driver eligibility
SHARE -> sorted User/CompanyMembership reference pins -> current grant SHARE ->
operation advisory -> owned Order UPDATE -> cash state/collection locks. Hints are
reloaded; changed identities reject instead of being adopted out of lock order.
Governance uses driver eligibility fence before sorted credential User UPDATE,
company grant advisory, membership/grant UPDATE and atomic session/version changes.
Active legal entity is SHARE-pinned. Bounded lock/statement/transaction deadlines;
no network inside transactions. Admission before committed revocation may finish;
new admission after revocation fails. Existing socket polling/in-flight timing window
remains; no claim of instantaneous or exactly-once external delivery.

Apply both additive migrations before new readers/writers, stop old cash/IAM writers.
No inferred legacy certification or automatic grants. Rollback must retain enforcement
or disable affected cash operations. Client cash request/queue changes require later
client work; none implemented here. Real registry/private credential delivery/operator
invocation remain unperformed. Preserve all prior infrastructure/device/RLS gates.

Final executed/reused evidence and checkpoints are recorded below when complete.
## Executed evidence (2026-10-06)

- 17 distinct actual PostgreSQL cases in
  tests/security/cash-capability-postgres.integration.test.ts. Focused reruns are
  NOT counted as new cases. Governance five, restricted custody/read/revocation
  seven, cross-company replacement/lock admission/tamper three, actual cash HTTP one; reassignment-retains-cash-holder one.
  Actual two-process Socket.IO established connections disconnect after grant revoke;
  actual Fastify selected sessions and cash endpoints exercised.
- 38 distinct unit/mock cases: 10 capability-intent/profile cases (unchanged pass
  reused), 14 strict input/context boundary cases and 14 compatibility adapter cases.
  Adapter mocks prove forwarding/containment only; database tests establish actual
  grants, cash transitions, durable uniqueness, rollback and lock behavior.
- Full 121-migration committed+new chain applied to owned PostgreSQL16 instances.
  Affected runs: 7, then10, then2, then6 passing cases; final execution
  coverage is recorded below; skipped cases reused only
  where exercised source/dependencies remained unchanged. Earlier attempted failures
  were not passes: corrected new SQL duplicate constraint-name syntax; replaced a
  null Decimal exception with explicit reconciliation rejection; documented the
  absent DOM-06 expected-obligation initializer instead of bypassing it. One earlier
  order-create statement deadline failure did not recur without overlapping checks.
- 7 exclusively owned instances used in this resumed validation segment (8 total
  including the earlier standalone governance run) were removed
  with exact container/run-label/tmpfs/no-mount checks and absence confirmed:
  cp-verification-42f0ab1fb6b3 (migration failure), 43cfd5f4f7bd (mixed failed run),
  4b85c744ea10, 468df1a4bcb3, 88458bd766ce, f771095d8cba and the final
  execution instance (recorded below). Earlier governance instance
  cp-verification-10dbea42860e also cleaned. No existing container/volume touched.
- Offline installed Prisma validate exit0, guarded against network/dotenv using
  the existing cp-prisma-offline-validate.cjs wrapper. This is syntax validation;
  manual SQL/Prisma field/FK/unique review and actual SQL execution are separate
  evidence, not complete semantic schema-to-SQL equivalence. Trigger/check/partial
  index semantics live in the migration. No client generation or dist emission.
- Commands: node --max-old-space-size=4096 node_modules/jest/bin/jest.js
  --runInBand <named unit suite>; existing owned disposable wrapper
  C:\Users\Anvar\AppData\Local\Temp\cp-dom05-run.cjs invokes the named PG suite
  with --runInBand --testTimeout=60000 and focused --testNamePattern filters;
  exact guarded run-ID/loopback database identity required by the suite.
  Final node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
  is recorded after completion below. An earlier default-heap attempt exhausted
  memory and an intermediate check found the test-only token field typo; neither
  is counted as passing evidence.

Unchanged DOM-01/02/03/04 logistics, pricing, entity setup, accepted driver, session
lineage and financial-policy evidence reused with its historical boundaries. The
former cash-custody-authority unit contract was replaced by adapter containment
checks plus actual new PostgreSQL invariants; broad role/Float COD/implicit handoff
expectations are not supported behavior. Historical cash-custody-postgres and
cash-finance-postgres suites that call those old producer contracts are not current
DOM-05 acceptance evidence; they need DOM-06-compatible fixture/producer treatment
before reuse. Finance ingestion/posting implementation is unchanged, but new
restricted receipts are held and its historical tests do NOT restore this path.

Storage/provider/Redis/email are mocked or unused. No real invitation, provisioning,
key registration, device, deployed transport, S3 or production validation. Socket
results establish the local two-process boundary, not instantaneous revocation;
existing sweep/in-flight window remains. No exactly-once external delivery claim.

Recipient membership must be explicit, not selected by a first-user/warehouse
lookup. Pending offers expose the exact recipient and expected event; no general
recipient directory or automatic selection/notifications were added in this batch.
The origin needs an explicitly identified accepted recipient; clients remain deferred.
Final reviewed execution source: 9 affected PostgreSQL cases passed after the
reassignment/durable destination and participant-lock scoping corrections; other
8 distinct cases retained their stated unchanged assertion boundaries. Last owned
instance cp-verification-3b38f919c588 removed and absence verified. Final no-emit
exit0 (4096MB heap), offline schema exit0; targeted staged scope/whitespace/secrets
review follows. No application build, dependency change or generated output.
