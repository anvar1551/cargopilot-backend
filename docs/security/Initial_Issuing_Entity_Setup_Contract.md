# DOM-04 initial issuing-entity setup — approved implementation

Owner approved the bounded contract after planning at baseline
`63a08ee931a29fbe0178d20b463e36432bfb11bd`. Initial setup is implemented and
synthetically validated; real registry registration, concrete company intent,
credential delivery and database invocation have NOT occurred.

## Current contract and compatibility

- Controlled `authorizeIssuingEntitySetup` accepts only an owner-signed
  `issuing-entity-setup.v1` intent: operationId, membershipId, userId, tenantId,
  companyId, tenantMembershipId, kind proposer/checker, action
  operator-authorize/operator-revoke, expectedAcceptanceId (explicit null for
  first appointment), profileRevision and bounded reason. The entire expected
  target tuple must agree with current database records; it is not ownership
  authority supplied by a tenant request. No HTTP owner endpoint or signing tool.
- New exact role keys `finance.entitySetup.propose` and
  `finance.entitySetup.approve` require their current durable owner acceptance and
  an explicit selected-company scope. Permission/role names alone cannot enable
  setup. No existing onboarding/operational/financial profile expands.
- `POST /api/auth/issuing-entity-setup/proposals` accepts operationId, reason and
  configuration; returns proposalId/contentHash. Configuration requires explicit
  baseCurrency, fiscalYearStartMonth 1..12 and recognized IANA timezone; optional
  reportingCurrency accepts null only and omission normalizes to null. Unknown
  fields/ownership/unsupported currencies reject. Server supported currency
  contract currently UZS/USD/CNY is shared with finance validation, not a
  permanent database or tenant enum. Future additions require deliberate exact
  calculation/storage/precision validation; no FX/provider guarantees follow.
- `GET /api/auth/issuing-entity-setup/proposals/:proposalId` returns only owned
  configuration, hash, reason, server time and minimal decision metadata. A
  proposer sees their selected membership's proposals; a checker sees proposals
  within the explicitly accepted company. No general finance settings access.
- `POST /api/auth/issuing-entity-setup/decisions` accepts operationId, proposalId,
  contentHash, approved/rejected decision and reason; returns proposalId,
  decision, legalEntityId (null for rejection), exact configuration/contentHash.
  Checker must be a different User; both current authorities and the original
  maker acceptance must remain eligible. Matching retries reauthorize. Changed
  content/context and reuse across setup command types reject.
- Atomic insert-only entity + protected decision/receipt + finance audit.
  Setup action is the durable publication evidence; there is NO new executable
  finance-outbox configuration event, account/period creation or accounting
  activation. Existing invoice issuance still writes its held billing fact.
- The existing owned Organization (type company) supplies issuing identity via
  FinanceLegalEntity.companyId and invoice companyId. No name, registration or
  tax identity is invented/copied from a customer. This is operational manual
  invoicing, not statutory invoice certification. Separately approved policy
  remains authoritative for tax treatment, precision/rounding, route, prefix,
  due days and eligible states; accepted currency must equal entity base currency.
- Authority changes revoke selected sessions/increment authorizationVersion
  atomically; actors must log in again. Suspended targets may have setup authority
  removed without reactivation. Unrelated grants/scopes/memberships survive.
  Revocation does not deactivate a published entity or silently revoke other
  financial grants. Existing entities, including inactive/null-owned ones, block
  initial creation; no adoption/backfill. New accepted settings have an additional
  database update guard; later corrections/deactivation remain unavailable.

## Concurrency, rollout and evidence

All involved User references precede sorted selected-membership references,
then company setup advisory fence, operation identity fence, authority and
proposal/publication locks. Owner changes use credential User UPDATE and
membership UPDATE; business actions use KEY SHARE reference pins, authority
SHARE and fresh eligibility. One entity/company and one decision/proposal remain
database-unique. Setup operation reuse across proposal/action tables is checked
under a shared operation advisory fence; not represented as a read-then-create
concurrency guarantee. Both race orders are exercised. Admitted approval may
finish before waiting revocation; after committed revoke new work/receipts deny.
2s lock/acquisition,5s statement,10s transaction bounds; no network work in these
transactions. No claim of universal deadlock freedom or instant socket revocation.

Apply additive `20261006210000_initial_issuing_entity_setup` before new writers;
generate the deployment client from reviewed schema through normal build workflow.
No local client generation was required: new persistence uses explicit parameterized
SQL, existing entity client fields unchanged. Seed only reviewed permission catalog
entries through the separately controlled deployment procedure; possession still
does not supply authority. Keep legacy configure/upsert/settings.manage blocked.
Rollback disables new setup actions rather than restoring unapproved writes;
retain accepted evidence/entity/ownership protections. Database owners/schema
administrators remain outside application tamper protection.

Executed evidence:

- 17 distinct new actual PostgreSQL cases using the actual implementation,119
  migrations (118 prior +1 additive). Final combined16 passed, then1 additional
  exact signed-owner-tuple rejection case passed; reruns are not added as cases.
  Includes the onboarding-to-invoice service journey with no entity seed, real
  customer/address and normal durable order creation, appointed independent setup
  and financial actors, approved tariff/policy, payer, exact110.0100UZS price,
  manual same-currency invoice and authorized retries. Deliberate legacy/null
  entity insertion is confined to a separate negative case.
- Actual PostgreSQL concurrent matching and competing approvals, both owner-revoke
  schedules with pg_blocking_pids barriers, conflicting/cross-command identities,
  self/foreign/missing/revoked/stale authority, suspended removal, compound bridge
  rejection and independent checker trigger, no-partial-effect graph comparisons,
  entity/audit and role/version/session rollback, immutable UPDATE/DELETE/TRUNCATE
  and protected new configuration. SQL catalog checks verify selected declared
  relationships; manual source review is not complete semantic schema equivalence.
- Actual HTTP setup contracts plus selected-session invalidation and closure of
  existing sockets in two isolated processes. Reuses established socket timing
  bounds; not Redis adapter, native device or infrastructure certification.
- 105 distinct affected unit/mock cases:18 new setup input/contract cases +31
  existing permit/ledger cases +56 order-creation cases (54 existing +2 new).
  Initial full order run55 passed/1 new fixture assertion failed; corrected safe
  projected actor expectation and targeted mock setup, reran only2 new cases.
  Setup-only18 rerun after owner tuple normalization is not18 extra cases.
- Offline network/dotenv-denied Prisma syntax validation and final no-emit passed.
  Commands: `node %TEMP%/cp-prisma-offline-validate.cjs`;
  `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit`;
  Jest runInBand setup/onboarding/ledger files, and affected order-creation-authority
  file with the2-case correction rerun. Database runner variants use the existing
  bounded harness, exact DOM-04 selectors and no live endpoints.

Initial database run9 passed/2 failed: a test barrier mistakenly searched SQL text
for a bound parameter, and normal creation attempted carrier authorization with
zero legs. Corrected the barrier with a bounded wait. The bounded integration fix
performs an owned minimal leg lookup and skips only nonexistent carrier work;
actual legs still invoke unchanged shipment.bookCarrier authorization. New mocks
prove both branches. No grant or provider bypass was added. Intermediate9-case
affected run passed; final16-case and additional1-case results above supersede it.

All4 owned disposable instances were removed with identity/run-label/tmpfs checks
and filtered absence verification: cp-verification-368ad86e36a0 (initial failed),
cp-verification-28fd1a9de63a (affected),cp-verification-ba02bcf62a11 (16-case),
cp-verification-a962e0dc1c81 (owner tuple). Cached image --pull never, synthetic
credentials, random loopback-only port,1CPU/512MiB/128PIDs/256MiB tmpfs, no existing
volumes/containers/compose. Test keys remain in memory; owned public registries
removed by test cleanup. Policy-blocked cleanup and dist untouched.

External boundaries: labels/storage/queue transport mocked in this focused service
journey, no provider calls/real files verified. Detailed unchanged price/invoice,
logistics, proof, cash, lineage/journal evidence reused only for unchanged behavior;
the creation caller was separately tested after the empty-work correction.
Accounting/FX/cash authority remain unavailable; real company values/key handoff,
deployment/RLS/historical ownership and client/device work remain release gates.

## Historical plan and approved policy record

Planning only at HEAD 63a08ee931a29fbe0178d20b463e36432bfb11bd. No application/schema changes, tests, services, keys or provisioning executed. This proposal requires the approvals below; it is not current enforcement.

## Current enforced boundaries

FinanceService.configureLegalEntity and PrismaFinanceRepository.configureLegalEntity both reject through FINANCE_CONFIGURATION_APPROVAL_REQUIRED. Do not remove those guards or enable PUT /legal-entity/settings.manage. Financial delegator authorization requires an existing owned active FinanceLegalEntity, so it cannot bootstrap initial setup. FinanceLegalEntity has unique companyId and compound tenant/company ownership; one entity per company is the existing model.

Billing authority requires fresh selected context, explicit company scope, an active owned entity and accepted financial capability. Invoice issuance additionally requires owned payer, accepted exact price, approved immutable billing policy, eligible order state and selling currency equal to entity baseCurrency. Invoice facts remain held; setup does not authorize accounting execution, FX, periods, accounts, cash or payments.

Sources: prisma/models/finance.prisma; finance-core/transport/validation.ts; finance-core/application/legal-entity-access.ts; finance-core/infrastructure/prisma-finance.repository.ts; pricing-core/repo/billing-policy.ts; pricing-core/domain/billing-calculation.ts; invoice-core/application/accepted-issuance.ts; identity-access/application/tenant-onboarding.ts and financial-delegation.ts.

## Exact initial configuration

| Field | Proposed input and existing consumer/validation |
| --- | --- |
| baseCurrency | Required explicit UZS, USD or CNY: current FINANCE_CURRENCIES. No inferred currency. Billing issuance compares it to accepted currency; ledger and source FX checks use it. Supported storage does not prove provider support. |
| fiscalYearStartMonth | Required integer 1..12, existing configure schema range. No January default. Stored/read setting; current mutation code protects changes after periods exist, but is blocked. Initial invoice issuance does not consume it. |
| timezone | Required trimmed 1..100 characters, existing configure schema bounds; additionally validate recognized IANA timezone with installed Intl at implementation. No Asia/Tashkent default. Stored/read setting; current invoice dueDays use elapsed server-time days, not timezone/calendar arithmetic. |
| reportingCurrency | Optional null only for this initial domestic contract; omission normalizes to null. Existing schema also accepts UZS/USD/CNY, but alternate reporting/conversion is unnecessary here and remains deferred. No reporting currency is inferred. |
| operationId / reason | Required lowercase UUID per immutable intent; trimmed reason 1..1000. Separate IDs for proposal and approval, preserved across uncertain responses. |

Tenant/company/actor/createdBy/updatedBy IDs and server timestamps derive from verified selected membership. New entity ID generated server-side, isActive=true only upon independent publication. Neither active state nor ownership is a request field. Unknown fields reject. Strict canonical content with version initial-issuing-entity.v1, explicit values and explicit null is hashed deterministically; reasons and exact context participate in request fingerprint. Database enum/check validation accompanies the new path; do not rely on current permissive SQL defaults.

No issuing tax ID, legal name or address field exists on FinanceLegalEntity. Customer taxId is not issuer identity. Do not invent fields or copy customer identity. This is the existing operational manual-invoice record, not statutory invoice compliance. Tax treatment/rate/reference, precision/rounding, route/zone rules, charge composition, eligible shipment states, invoice prefix and due days stay in the separately proposed/independently approved BillingPolicyVersion; do not duplicate them in setup. Real values require company review in each concrete intent, not a universal default approval.

## Narrow authority, before any entity exists

Proposed new, immutable authority revision issuing-entity-setup.v1:

| Authority | Permission proposal | Ceiling |
| --- | --- | --- |
| Setup proposer | finance.entitySetup.propose | Exact active company membership, tenant/company and revision; initial setup only. Can propose and read its owned setup evidence, never approve, edit an entity or delegate. |
| Setup checker | finance.entitySetup.approve | Exact active company membership, tenant/company and revision; reads exact proposal and approves/rejects, never edits its content. |

These are proposed NEW registry keys, not current permissions. Do not grant finance.settings.manage or broaden settings.read. Reading setup evidence is part of the narrow action; it does not expose arbitrary finance data. Require explicit persisted selected-company scope and fresh active user/company/tenant/tenant membership/company membership. Warehouse/customer scope cannot substitute. Drivers are not setup administrators. Preserve unrelated roles and other-company access.

Only controlled installation-owner invocation may authorize/revoke these authorities: existing explicitly registered Ed25519 registry, operator cargopilot-bootstrap-owner, exact normalized intent/operation ID/new revision and at most five-minute signed permit; registry/expiry rechecked inside mutation. Add only the new revision to existing strict verifier; no signing helper, HTTP owner endpoint, tenant key discovery or automatic onboarding expansion. Owner intent specifies target membership, proposer/checker kind, company/tenant bound from authoritative target, expected prior acceptance ID, action and reason. Immutable owner action records fingerprint, public-key fingerprint and operator ID, never permit signatures/private keys or credentials. Stable authorized retries revalidate owner contract before returning a minimal receipt.

Authority records reference membership/user/tenant/company through compound constraints, no legalEntityId prerequisite. Proposer and checker may be appointed to the same company, but approving User must differ from proposing User even across multiple memberships. Both current accepted authorities are revalidated at approval; revoked/suspended proposer cannot leave an executable pending proposal. No authority to grant financial business profiles: after entity publication, existing owner-authorized DOM-03 proposer/checker and tenant-side financial grant workflow are still required.

## Publication, retries and lock order

Proposed additive models: IssuingEntitySetupAuthority (current accepted owner pointer), IssuingEntitySetupProposal (immutable content/context/hash), IssuingEntitySetupAction (append-only owner/decision/receipt evidence). Compound keys/FKs bind all actor references and published entity tenant/company; UNIQUE tenant/operation identity, unique decision per proposal and existing unique entity/company protect duplication. New publication acceptance links exact proposal, maker, checker and content hash. Protect immutable evidence against UPDATE/DELETE/TRUNCATE; database-owner/schema-admin powers remain outside application tamper protection.

Proposal API accepts only operationId, reason and configuration. Decision API accepts operationId, proposalId, contentHash, decision approved/rejected and reason. Ownership never comes from these fields. Minimal responses return proposal/decision/entity IDs, exact approved settings, digest and server status/time; no credentials. Matching retries always require current selected action authority. A revoked authority cannot use a receipt to regain access. Conflicting content/context/actor/decision reuse rejects without effects. A new operation ID cannot overwrite an existing entity.

Plan one short database transaction per action with existing bounded deadlines; no network work. Lock all involved User references first, then exact CompanyMembership references, sorted in each class (KEY SHARE for business actors, UPDATE for credential/session authority mutation); then tenant/company setup advisory fence; accepted setup authority SHARE/UPDATE as applicable; authoritative proposal/decision; publication. Reload eligibility after locking. Owner revocation uses the same order, changes authority/managed role, protected audit, authorization version and selected session lineage atomically. Inspect actual FK/credential/advisory paths before implementing and prove both acquisition orders; do not invert User/membership versus grant/lineage locks fixed by FINANCIAL-LOCK-01.

Independent approval atomically inserts the entity and immutable acceptance/action plus source-bound held configuration fact if an outbox fact is required. No active worker execution or accounting publication is enabled. Insert-only, never the contained legacy upsert. UNIQUE companyId remains final protection against other concurrent creators. Any conflict/failure rolls back entity/action/outbox together. An uncertain commit response retries the original identity; a confirmed matching retry returns the owned original publication. Concurrent different proposals for one company cannot both publish; losing proposal gets explicit already-configured/conflict response, not success for different content.

## Existing entities, corrections and revocation

Reject initial publication whenever any entity exists for that company, including inactive or tenant-null entities; no adoption, ownership guessing or overwrite. Existing independently established synthetic/current entities retain current behavior without being falsely certified by DOM-04. Do not require retroactive setup acceptance for them in this slice; a separate explicit certification/correction contract would be needed for real legacy configuration. New DOM-04 entities have protected acceptance evidence and unchanged active/ownership checks for existing consumers.

Configuration changes, base/reporting currency conversion, entity deactivation/reactivation and later corrections stay unavailable through this contract. Owner revocation removes future setup ability, invalidates pending execution and relevant sessions, but does not erase or deactivate an already published entity, revoke unrelated financial grants, or rewrite invoices. Work already admitted under locked fresh authorities may finish before waiting revocation commits; work admitted afterward rejects. A requested stop to issuing requires a separately approved operational contract, not reinterpretation of setup-authority revocation.

## Finite implementation and acceptance plan (after approval)

1. Add strict intent normalization, narrow registry keys/permit revision, company-bound authority/proposal/action schemas and one additive migration. Preserve historical migrations, settings containment and immutable evidence; no backfill/default entity assignment.
2. Controlled owner acceptance/revocation plus scoped proposal/read/decision endpoints using existing fresh context/session helpers and the above lock order. No frontend, driver, invitation or generic configuration redesign. Deploy schema first, then new writers; old configure upsert remains blocked. Rollback disables new actions, preserving evidence and current authorization rather than restoring unapproved writes.
3. Use one owned disposable PostgreSQL run with actual services: onboarding -> separate users through current enrollment -> exact owner acceptance of setup maker/checker -> immutable proposal/independent publication -> existing owner financial delegator acceptance -> DOM-03 financial actor grants -> approved tariff/policy -> scoped customer/addresses/order, payer and accepted standard exact price -> same-base-currency manual invoice. No direct entity insert prerequisite. Test-only keys/explicit synthetic configuration; storage/providers mocked and accounting held. Existing enrollment/operational prerequisites remain explicit; setup does not grant invitations or shipment/customer operations automatically.
4. Focused unit/HTTP and actual PostgreSQL: missing/foreign/revoked authority, same-User checker, altered hash/content, unknown fields, null/foreign memberships, existing entity rejection, identical/conflicting retries, concurrent matching publication, competing proposals, injected entity/audit/outbox rollback, owner revoke versus acceptance in both orders, HTTP/socket session invalidation and preservation of unrelated memberships/grants. Assert one entity/decision/fact and exact settings; no partial effects on rejection. Reuse unchanged pricing/invoice/logistics evidence; final no-emit and schema checks, owned cleanup verified. No claim of real key handoff, infrastructure or statutory invoice verification.

Completion: a newly onboarded synthetic company reaches the existing same-base-currency manual invoice without directly seeding its entity, using independently accepted setup and financial actors. This is not accounting, FX, cash readiness or production certification.

## Consolidated approval needed

1. Approve the two company-bound setup authorities and proposed exact keys/revision, established only by owner permits; explicit company scope; checker differs by User from maker; both remain eligible at decision. No automatic first-admin/DOM-03 expansion. Company staff make concrete setup decisions once appointed, without owner signing every business action.
2. Approve the initial supported field contract: explicit UZS/USD/CNY base currency, explicit fiscal month and recognized IANA timezone, reportingCurrency null only; no inferred tax/defaults. Concrete real values still require reviewed company intent; initial setup does not certify statutory issuer identity.
3. Approve insert-only initial publication and lifecycle policy: any existing entity blocks it; revoking setup authority blocks pending/new setup but leaves published entity/invoices intact; later correction/deactivation/legacy certification requires a separate contract. No automatic financial grants or accounting activation.
