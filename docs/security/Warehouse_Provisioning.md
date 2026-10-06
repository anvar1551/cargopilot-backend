# DOM-02 controlled warehouse provisioning

Baseline 4e30c1f01a74be839a69f2231c0f8b952b185099. Finite plan before implementation:
1. Add separate accepted membership-bound warehouse-provisioning.v1 authority and
   immutable owner/action/create journal with exact tenant/company/user bridges.
2. Owner's existing signed-permit contract binds operationId, membershipId,
   operator-authorize/operator-revoke, profileRevision warehouse-provisioning.v1 and
   bounded reason. A separately registered revision is required; no automatic trust.
   Authorize only an active selected-company administrator with explicit company
   scope and non-platform company roles. Add warehouse-provisioner.v1 containing
   warehouse.create only. Revocation disables authority/removes only this role and
   revokes exact selected sessions atomically. Existing onboarding/profile ceilings
   unchanged. No material additional business decision is needed for this policy.
3. Existing POST warehouse creation gains mandatory operationId. Strict validated
   existing fields only, tenant derived from verified selected context. Normalize
   fields and bind receipt to actor/TM/CM/company/tenant and exact intent. Lock
   credentials/membership/authority/operation and current ownership; fresh permission
   and enabled accepted authority required even for matching retries. Matching retry
   returns original safe projection; conflicting reuse rejects. Warehouse+immutable
   receipt/audit commit together; no storage/jobs/provider or automatic scope grants.
4. Actual PostgreSQL creation -> separately owner-approved warehouse ceiling ->
   operational warehouse invitation/enrollment -> explicit-scope custody discovery.
   Focused foreign/unknown/revoked/conflict/concurrency/rollback/immutability tests,
   affected creation consumers/unit/HTTP, schema/client/no-emit; owned cleanup.
5. Reviewed local implementation and evidence/dashboard milestones. Stop DOM-02.

Migration first, stop old creation writers, then compatible source/client artifacts.
No backfill or ownership inference. Creating company is audit context, not exclusive
warehouse ownership. Rollback retains authority enforcement or disables creation.
No real key registration/provisioning/invitations/clients/deployment. Real registry,
intent review, credential/token delivery and invocation need separate authorization.

## Implemented authority and creation contracts

Internal authorizeWarehouseProvisioner(db,{intent,permit,signature}) accepts only
operationId (UUID), membershipId (UUID), action operator-authorize/operator-revoke,
profileRevision warehouse-provisioning.v1, reason (trimmed1..500/no controls). The
existing sole installation-owner Ed25519 verifier binds the exact normalized intent
fingerprint, revision, key, operation and maximum5-minute expiry. No tenant/admin
role can mint a permit. The registry currently accepts one explicitly selected
revision; controlled out-of-band registration/switching is required, not automatic
key discovery. Registry/key revocation denies new permits; already accepted business
authority is disabled through the explicit owner-revocation operation. Last registry
check-to-commit timing remains; stop provisioning during key retirement.

The target must have current active CM/TM/tenant/company, consistent user/tenant
bridges, explicit selected-company scope and only company/non-system/non-owner
roles. Owner authorization creates only warehouse-provisioner.v1 [warehouse.create]
and the separate durable accepted authority. Authority points to its immutable exact
member/tenant/company accepted owner action. Revoke disables authority, removes
only this role and revokes exact selected sessions/increments authorizationVersion
atomically with owner audit. Other roles/scopes/memberships are not altered. No
new onboarding profile, operational ceiling, warehouse scope, driver/finance/grant
permission or invitation authority is conferred.

POST /api/warehouses (also trailing slash) requires current authenticated selected
context, warehouse.create and accepted authority. Body: operationId, name,
location; optional type warehouse|pickup_point (default warehouse), region,
latitude, longitude. Unknown/ownership/nested relation fields reject. Names1..160,
locations1..500, region<=160, no control characters; text trimmed, empty region/null
coordinates canonicalized. Coordinates must be finite numbers in[-90,90]/[-180,180]
or null. Invalid types/aliases/coordinate strings reject instead of being silently
coerced or defaulted. Missing/invalid operationId is400; missing permission/authority
is403 (a revoked HTTP session is401); conflicting authorized reuse is409.

Response stays201 with id,name,type,location,region,latitude,longitude,createdAt.
Matching authorized retry returns the original creation projection/ID/time even
if subsequently edited; it verifies the referenced warehouse still belongs to the
tenant. The receipt authorizes neither general read nor later mutations. Clients
must retain operationId and normalized intent through ambiguous responses; client
implementation/verification is deferred. Existing update/read/projection/scope
contracts remain unchanged; creation fields cannot choose ownership or assignments.

## Atomicity, isolation and rollout

Lock order follows existing IAM conventions: credential User -> operation advisory
lock -> selected membership -> tenant/company/TM SHARE -> durable authority UPDATE.
Authority/permission/context are reloaded under those locks before checking receipts
or writing. Owner revoke and creation serialize through the same member/credential
locks. No network call or extra outbox is necessary: the append-only action is both
protected creation receipt and security audit, in the same warehouse transaction.
Concurrent matching requests insert one warehouse/action; failed final audit rolls
back the graph. Pending transactions are bounded by existing2s lock/5s statement
limits and15s transaction timeout. No exactly-once external-effect claim.

Additive WarehouseProvisioningAuthority and WarehouseProvisioningAction relations
have compound CM/user/tenant/company/TM bridges and tenant/warehouse FK. Accepted
authority FK is deferred until transaction commit. Journal UPDATE/DELETE/TRUNCATE
reject; database owner/schema administrator can alter/drop protections, so absolute
immutability is not claimed. Warehouse tenant ownership remains unchanged; creator
company is journal provenance and does not establish exclusive company ownership.
Creation does not mutate MembershipScope, CompanyDelegationAuthority or other grants.

Apply new migration20261006180000_controlled_warehouse_provisioning before new
source/generated client rollout; stop old creation/IAM writers and never execute
preserved stale dist bootstrap. No legacy authority backfill. Explicit real public
registry/profile registration, approved concrete permit/intents, secure token/initial
credential delivery and authorized database invocation remain external gates. The additive migration provisions only
warehouse.create catalog metadata, never a role assignment or automatic permission
registry entry; missing catalog still denies. No broad
permission/bootstrap seed is a provisioning shortcut. Rollback keeps durable authority
checks or disables creation; never return to capability-only creation.

A created warehouse must separately enter an owner-approved operational warehouse
ceiling. The existing company invitation workflow then grants only its exact warehouse
scope to operational-warehouse.v1 staff. Creating it does not automatically allow even
the creator to list/read/access that warehouse. No client changes or real invitations.

## Evidence (completed results recorded below)

Actual PostgreSQL tests use synthetic owner keys/credentials and existing actual
onboarding, login, owner ceiling, invitation/acceptance and scoped custody query
implementations. The read/access test provisions a clearly synthetic pre-existing
operational Order/Tracking/custody source solely to exercise new staff scope; it is
not order-creation evidence. The separate affected normal connected journey checks
current creation consumers; storage/network/provider boundaries remain mocked.
Unchanged DOM-01 driver/concurrency/socket and finance evidence is reused, not newly
claimed. S3, Redis, native device, production rollout and real credential delivery
remain unverified. This bounded slice does not finish remaining DOM-02 dispatcher,
planning/pricing/invoice actor provisioning or DOM-03/05 cash authority.

## Finite validation record

Commands executed for changed boundaries:
- node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse-tenant-containment.test.ts tests/security/warehouse.phase0a.test.ts tests/security/tenant-onboarding.test.ts
- node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse-provisioning.test.ts
- affected projection-only rerun: node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse.phase0a.test.ts
- node "$env:TEMP/cp-prisma-offline-check.cjs" (WASM syntax validation, ignored Prisma7.10 client generation; dotenv/network blocked)
- node "$env:TEMP/cp-warehouse-provisioning-run.cjs" (combined owned PostgreSQL setup,21 provisioning cases plus1 affected connected journey)
- node "$env:TEMP/cp-warehouse-provisioning-final-run.cjs" (only the21 provisioning cases after catalog correction; connected journey not repeated)
- final $env:NODE_OPTIONS='--max-old-space-size=4096'; node node_modules/typescript/bin/tsc --noEmit

77 distinct offline/mock cases pass (35 warehouse containment,12 response boundaries,
19 onboarding verifier regressions,11 new normalization/input cases). Reruns are not
additional cases. Initial projection fixtures lacked operationId/accepted authority;
only fixtures changed, retaining sensitive-field/exception assertions. PostgreSQL
setup/type errors in the synthetic Order read fixture and administrator prerequisite
ordering were corrected. The catalog guard correctly rejected missing warehouse.create;
new migration now inserts only its reserved metadata without any role grants. No
security assertion weakened. The combined run's connected journey passed1/5 skipped;
only failed new provisioning cases require final rerun. Final results follow below.

Owned disposable runner uses cached PostgreSQL16/no pull, sanitized endpoints,
loopback random port, synthetic credentials,1CPU/512MiB/128PID and268MiB tmpfs.
Markers/database names, labels/container identity/mounts verified before removal;
absence checked afterward. Tests have60s individual deadlines, bounded client pools
and5/10s statements,3/5s locks; race barriers5s. Suite process deadline240s.
Full117 migration chain is setup evidence; unchanged historical concurrency not
rerun. Initial owned cp-verification-89654eb3a595 and subsequent
cp-verification-7e0ad7ae1590 were removed/absence verified, no volume/bind storage.
The latter combined process failed overall because new provisioning cases failed,
even though the affected normal connected journey passed; it is not reported as
an all-green run. Final pass and cleanup are recorded below after completion.

Final evidence:21/21 new PostgreSQL cases passed (suite81.905s), final117 migration
chain including metadata; one separately executed affected normal connected journey
passed (suite88.228s;5 unchanged cases skipped). These are22 distinct executed
PostgreSQL cases, not retries added as new cases. 77 distinct offline/mock cases
passed, final schema syntax/client compatibility and no-emit exit0. Final owned
cp-verification-10a2c914be7d identity/tmpfs checked, removed and absence verified.
Source/SQL review confirms new fields/bridges/targets/checks/triggers; SQL-only guards
and deferred-FK semantics are retained intentionally. This is not complete historical
schema-to-SQL equivalence or historical-row certification. DOM-02 warehouse scope
complete; stop. No real invocation, keys, invitations, clients, push or deployment.

Final index-map syntax verification: node "$env:TEMP/cp-prisma-offline-validate.cjs"
passed exit0 without generating clients or opening network/database connections.
