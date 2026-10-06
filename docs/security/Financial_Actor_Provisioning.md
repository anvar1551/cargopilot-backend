# DOM-03 financial actor provisioning

Baseline af2602ddfc8a0754d4df8a4e3599353f97083c7c. Owner-approved policy, backend only.

## Finite implementation plan

### Focused lock-order review (baseline 65929369b61acab8e81f1620c2747d1b199b6271)

Plan: reproduce actual tariff publication competing with grant revocation in
both acquisition orders, including User/CompanyMembership foreign-key locks.
Inspect credential/refresh locks and business advisory locks before choosing a
correction. If confirmed, pin the business actor's identity/membership before its
grant fence, retaining fresh eligibility and atomic grant/session effects. Prove
admitted work completes, post-revocation work denies and injected failures roll
back. No schema/policy/API expansion; preserve old-writer rollout containment.

1. Verify and close pricing.write draft-only boundaries before granting pricing-maker.v1. Authoring must not modify/delete published plans, accepted references or immutable versions; default selection cannot mutate another published plan.
2. Add separate owner-established financial proposer/checker ceilings, immutable six-profile allowlists and company/entity-bound proposals/independent decisions. Existing onboarding, operational and driver ceilings remain unchanged. No self-targeting; checker differs from proposer and recipient by User identity. Replacement/revocation validates removed and proposed grants. Role/scope/version/session effects and protected acceptance/audit commit atomically.
3. Enforce accepted financial ceilings at affected service/repository execution boundaries, with fresh selected context and locked acceptance. Existing customer/object checks remain. No adoption of unmanaged grants, no cash capabilities or settings.manage. Existing operational enrollment provides credential-bound identities; financial authority is a separate independently accepted supplement, not an email identity adoption.
4. Validate provisioned synthetic actors, conflicts, duplicates, concurrency, rollback, unrelated membership/grant preservation and HTTP/socket revocation in owned disposable PostgreSQL. Synthetic pre-existing entity/configuration is an explicit prerequisite, not DOM-04 provisioning. Run affected offline checks and final no-emit; review and checkpoint coherent milestones.

## Approved profiles

- pricing-maker.v1: pricing.read, pricing.write, pricing.tariffs.propose, billing.policies.propose.
- pricing-checker.v1: pricing.read, pricing.tariffs.approve, billing.policies.approve.
- billing-operator.v1: customers.read, billing.payers.bind, pricing.orders.accept.
- price-exception-checker.v1: customers.read, pricing.orders.approve.
- manual-invoice-issuer.v1: customers.read, finance.invoices.read, finance.invoices.issue.
- entity-configuration-reader.v1: finance.settings.read.

Each acceptance binds an explicit selected company and authoritative legal entity. Tenant-owned customer masters remain subject to current customer/object authorization; no exclusive company ownership is invented. Routine financial grant decisions belong to independently authorized tenant-side staff; installation-owner permits establish their ceilings, not every shipment or grant. Tariff/policy and exception maker/checker controls remain independent of grant acceptance.

## Deferred boundaries and rollout

Cash supplemental capabilities remain unavailable until DOM-05 supplies narrow action/read contracts and authoritative membership/custody checks. Do not append roles/scopes to managed drivers or grant shipment.update/view. No cash-settlement checker profile here.

DOM-04 requires a separate immutable initial-configuration proposal and independent decision bound to exact company/entity, base currency, timezone/fiscal settings and any approved tax identity. Proposal maker and checker must be independently authorized and different human identities. No values/defaults or eligibility are invented; finance.settings.manage stays contained. Newly onboarded companies without an independently established entity remain billing-blocked.

Migration precedes source rollout; stop old financial/IAM writers. No legacy acceptance backfill or automatic administrator expansion. Rollback must preserve the new accepted-authority checks or disable affected operations. Protected journals do not resist database-owner/schema-administrator powers. Real keys, grants, delivery and invocation remain unperformed. Clients deferred.

## Initial DOM-03 checkpoint evidence

DOM-03 implemented and tested within this finite scope. No real provisioning or
complete onboarding-to-invoice readiness claim.

- 20 distinct actual PostgreSQL cases passed in
  tests/security/financial-provisioning-postgres.integration.test.ts. Coverage:
  owner establishment, existing operational enrollment/selected login, independent
  identities, company/entity/profile ceilings, matching/conflicting retries,
  concurrent acceptance and replacement/revocation, stale decisions, suspended
  recipient revocation, cross-company/unrelated-grant preservation, managed driver
  eligibility/zero scopes, rollback, compound acceptance constraints and protected
  UPDATE/DELETE/TRUNCATE journals. Actual provisioned pricing/policy/payer/price
  revision/manual invoice services and the three HTTP contracts passed. The
  existing-socket revocation case used two actual isolated loopback processes;
  Redis was mocked. Reruns are not additional distinct cases.
- 118 migrations applied in the reused isolated runner, including this additive
  migration and its established synthetic historical-migration prerequisite.
  Final command: node "$env:TEMP/cp-financial-provisioning-run.cjs"; Jest child
  used --max-old-space-size=4096, --runInBand and --testTimeout=60000, with a
  360-second process deadline. Run cp-verification-9b82f7d9f37b used a cached
  PostgreSQL image with --pull never, loopback random port, synthetic credentials,
  1 CPU/512MiB/128 pids and 256MiB tmpfs. Identity/label/storage checks preceded
  removal; absence verified, no volume/bind storage. Earlier failed/interrupted
  attempts were also verified cleaned. An initial default-heap exhaustion and an
  inadvertently unchanged-heap attempt produced no passing evidence; the latter
  was stopped by its exact test-process identity before rerunning with 4GiB.
- 49 distinct offline/unit/mock cases passed: 8 financial-profile cases,
  19 affected onboarding cases (permit revision changed), and 22 pricing boundary
  cases (20 existing plus 2 draft-history rejection cases). Targeted reruns after
  fixture/mock corrections are not added to these totals.
- Offline Prisma WASM validation and ignored application-client generation passed
  through node "$env:TEMP/cp-prisma-offline-check.cjs", with dotenv/network denied
  and a synthetic invalid endpoint. No database or shadow database involved in
  that check. Focused manual schema/SQL review and actual compound-constraint
  tests supplement syntax validation; no complete semantic equivalence claim.
- Final node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
  passed (exit 0) for the initial DOM-03 checkpoint. The focused lock correction
  below has separate affected validation.

Earlier fixture failures (normalized owner-intent ordering, authoritative tariff
generation, and TRUNCATE CASCADE needed to reach the journal trigger) were corrected
without weakening verifier, state or integrity assertions. Unchanged exact-money,
logistics/cash, onboarding cryptography, detailed billing concurrency and driver
journey evidence is reused only for unchanged behavior; the new grant gates were
exercised here. Existing entity/configuration is an explicitly synthetic prerequisite,
not evidence of DOM-04 setup. Accounting remains held/unavailable; no provider,
S3/native device, real Redis or deployed-infrastructure validation.

## Implemented contracts

The internal `authorizeFinancialDelegator(db,{intent,permit,signature})` mechanism
requires the existing explicitly registered owner key, a maximum-five-minute signed
permit and revision `financial-delegation.v1`. Intent includes operationId,
membershipId, legalEntityId, kind (`proposer`/`checker`), action
(`operator-authorize`/`operator-revoke`), sorted unique profileRevisions and reason.
The owner authorizes exact company/entity membership and allowlists, not role names.
It adds only membership.proposeFinancial or membership.approveFinancial and the
durable accepted ceiling; no invitations, signing or owner endpoint is exposed.
Operator identity/key fingerprint are recorded in protected action evidence.

Authenticated routes under `/api/auth`:

- POST /company-financial-grants/proposals: operationId, membershipId,
  legalEntityId, profileRevisions, expectedAcceptanceId (null for first grant),
  reason. Returns proposalId/fingerprint. Pending proposals grant no access.
- POST /company-financial-grants/accept: operationId, proposalId, fingerprint,
  reason. Different authorized human checker accepts the exact immutable proposal.
  Returns selected membership/entity/profile revisions, managed roleIds and acceptanceId.
- POST /company-financial-grants/revoke: operationId, membershipId, legalEntityId,
  expectedAcceptanceId, reason. Either accepted proposer/checker must cover the
  complete removed grant. Same intent returns its receipt; no scope union bypass.

Unknown fields, unapproved profiles and duplicate profile names reject. Request
identity binds current actor/context and normalized intent. Proposals preserve the
observed enabled state and proposer acceptance identity; pending proposals cannot
silently follow revocation or owner-ceiling replacement. Concurrent decisions and
revoke/replace serialize under one bounded company financial-grant lock and sorted
credential locks. Acceptance requires one unique proposal decision. Roles, managed
grant, immutable action, authorization version and selected-session revocation
commit together. A rejected transaction leaves no accepted access/audit fact.

Financial recipients must already have an active explicit company-scoped membership.
Use the existing credential-safe operational invitation flow where its separately
authorized operational access is wanted, then propose financial access separately.
This is not a new finance-only enrollment/token delivery contract. Existing
operational roles are retained, so a clerk receiving a financial profile also keeps
their explicitly granted clerk capabilities. Unmanaged financial roles cannot be
adopted. Driver memberships and warehouse-only staff cannot receive these profiles:
adding company scope would broaden existing access. No scopes are inserted/deleted.
Financial roles are replaced/revoked only by this independently accepted workflow;
ordinary operational/driver ceilings cannot grant or remove them.

Financial mutation keys and finance invoice/settings reads require current accepted
financial grant evidence, exact role permissions and active matching entity. Shared
customers.read/pricing.read continue serving existing authorized operational readers;
they do not establish monetary or grant authority. Pricing, billing and invoice
mutation transactions hold SHARE on financial acceptance through commit, preventing
concurrent replacement/revocation from changing that accepted basis mid-operation.
Read checks and existing HTTP/socket/session checks retain last-check-to-effect and
socket sweep timing windows; no instantaneous revocation claim. Owner revocation of
a delegator blocks pending/new decisions; previously independently accepted recipient
access persists until explicitly revoked. It does not depend on the maker's login.
Suspended recipients cannot execute or receive replacement grants; their owned
managed grant remains revocable by an active accepted proposer/checker. Revocation
does not reactivate them or remove unrelated access.

Legacy capability-only pricing mutation and financial-read actors now fail closed
without managed acceptance. This is an intentional rollout break, not automatic
conversion. Source consumers and clients need selected context, retained operation
IDs, exact proposal fingerprints and expectedAcceptanceId. No client work done.

pricing.write changes/deletes only plans without a publication/version history.
Published/proposed source plans must be replaced with separately authored plans;
their immutable versions and accepted references are retained. Default maintenance
touches only unpublished drafts, leaving published precedence unchanged; ambiguous
approved buckets continue failing closed. No shared configuration mutation is enabled.

New migration 20261006200000_financial_actor_provisioning adds four tables,
compound membership/user/tenant/company and entity relationships, typed acceptance
references, independent-checker trigger, unique decisions and UPDATE/DELETE/TRUNCATE
journal protection. Acceptance FKs defer until commit. Array role/profile references
are checked against protected accepted content and exact current role definitions by
the application; they are not individual foreign keys. PostgreSQL schema-owner powers
can change constraints/triggers. No absolute immutability or complete isolation claim.

## Focused lock-order correction — FINANCIAL-LOCK-01

Baseline source review finding confirmed in actual disposable PostgreSQL:
tariff publication held FinancialMembershipGrant SHARE; revocation held the
recipient CompanyMembership UPDATE; publication's compound actor FK waited on
that membership while revocation waited for the grant. PostgreSQL detected a
deadlock and aborted one actual transaction. A second confirmed cycle involved
logout: lineage advisory lock -> session mutation -> membership-bound accepted
audit, versus revocation's membership lock -> lineage advisory lock.

The shared lockSelectedIdentityReferences helper pins User KEY SHARE followed by
the exact selected CompanyMembership KEY SHARE before financial grant SHARE or
logout's lineage fence. It selects IDs only and is not an authorization bypass.
Financial execution still reloads accepted grant/roles/current eligibility;
logout verifies signed exact token possession and stored selection first, then
reloads the locked lineage. Missing references deny without mutation.

| Path | Order retained/enforced |
|---|---|
| Financial execution | Domain advisory lock (where used), compatible entity SHARE (billing), actor User KEY SHARE, selected CompanyMembership KEY SHARE, accepted grant SHARE, fresh validation, business records/FKs. Identity/membership/grant pins last through commit. |
| Grant proposal/replacement/revoke | Sorted credential Users UPDATE, company grant advisory lock, actor/authority membership and authority locks, compatible entity SHARE, target membership UPDATE, target grant UPDATE, protected role/grant/action writes, refresh-lineage lock and session/version effects. |
| Verified logout | Exact signed token/stored selection, User KEY SHARE, selected membership KEY SHARE, lineage advisory lock, recorded session rows UPDATE, conditional revocation and protected actor audit. |
| Login/refresh/password | Existing credential User UPDATE first; refresh then lineage/session writes, password then session writes/audit. Their credential lock implementation is unchanged. |

Grant administration acquires no tariff/billing advisory or business-record locks.
Its entity SHARE is compatible with the business entity SHARE; it cannot hold a
recipient membership while waiting for a business-held grant after obtaining that
recipient's User UPDATE behind the business's identity pin. Likewise logout
cannot hold lineage while waiting for a grant administrator's earlier membership
lock. Reference KEY SHARE is compatible with business FK KEY SHARE. Independent
maker/checker and atomic version/session/audit effects remain unchanged.

Admitted work may finish before revocation commits. After committed revocation,
fresh business work and confirmed receipt retries reject. Revocation's normal
bounded lock/transaction deadlines still apply; timeouts roll back, not partial
success or automatic replay. This fixes the demonstrated cycles, not every
possible database deadlock or instantaneous revocation. Read checks outside a
business transaction and existing socket sweep/in-flight limits remain.

No API, permission, schema or migration change. Roll out the corrected financial
and logout writers together; keep unsupported old writers stopped. DOM-04,
DOM-05, accounting, real provisioning, clients and external verification stay
unchanged/unavailable. No infrastructure guarantee is inferred from database tests.

### Executed correction evidence

- Before each corresponding fix, the actual tariff/revoke and actual logout/revoke
  paths each reproduced a PostgreSQL deadlock with controlled barriers after real
  lock acquisition and pg_blocking_pids observations. Original reproduced source
  had no test omission of locks. Final historical regression cases explicitly
  omit only the new reference-pin locks to replay those old protocols; all
  authorization, business queries and grant/lineage fences still execute. These
  instrumented historical cases are not evidence of a current-protocol deadlock.
- Final node "$env:TEMP/cp-financial-lock-run.cjs" passed 11 selected distinct
  PostgreSQL cases in financial-provisioning-postgres.integration.test.ts:
  9 new cases (2 historical cycle reproductions, business-first/revoke-first,
  replacement, business/revocation rollback and both logout/revoke orders) plus
  2 affected actual tariff/policy and payer/price/manual-invoice regressions.
  18 unchanged cases skipped. Earlier baseline and intermediate passes/reruns
  are not extra distinct cases. Barriers execute actual statements; current
  protocol cases neither mock lock results nor omit locks. Complete graph digests
  cover rejected billing writes and the failed revocation before admitted work
  proceeds; successful competing work is distinguished from partial failure.
- 118 unchanged migrations applied only as reused disposable setup. Final owned
  cp-verification-b6cb900a546a and earlier e01aa079c887,611ebff32763,ef8e61b886eb
  instances were identity/label/tmpfs checked, removed and absence verified. All
  used cached PostgreSQL, --pull never, loopback-only random ports, synthetic
  credentials, bounded CPU/memory/process/tmpfs and test deadlines; no volume/bind
  storage or existing resources. No new schema/migration validation claim.
- node --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand
  tests/security/refresh-lineage.test.ts tests/security/logout-exact-token.test.ts
  passed 39 unit/mock cases, including 3 new ordering/missing-reference cases.
  These were affected by the logout/helper change; unchanged full IAM suites
  were not rerun. Mocks updated for explicit pins, not weakened possession,
  lineage, mutation or audit assertions.
- Final node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
  passed exit 0 after final source/test changes. Source/test code unchanged since
  those passing final checks; later changes are documentation only.

Unchanged grants/ceilings/role definitions, detailed financial calculations,
driver/logistics, protected journals and HTTP/Socket.IO revocation evidence reused
only where exercised behavior is unchanged. Real PostgreSQL concurrency/rollback
is demonstrated; no new provider/storage/Redis/device/deployed transport evidence,
no exactly-once or absolute deadlock-freedom claim. Stop after this correction.
