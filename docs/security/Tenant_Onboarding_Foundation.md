# Controlled tenant onboarding foundation

## Focused audit correction — 2026-10-05

Review of published baseline `985ab2f5a70ea6208ee9a472e669c71a49a67f37`
confirmed that row-level BEFORE UPDATE/DELETE protection did not reject TRUNCATE.
New additive migration `20261005200000_onboarding_receipt_no_truncate` installs
a statement-level BEFORE TRUNCATE trigger using the existing rejection function,
consistent with the other append-only journals. The published onboarding migration
is unchanged; apply the new migration before claiming TRUNCATE protection.
No Prisma model, API, permit, profile, credential or login behavior changes.

This protects ordinary statements with triggers enabled, not absolute immutability:
database owners/schema administrators can disable/drop triggers or replace the
function/schema. Privileged database access, role/DDL controls, backups and external
audit protection remain separate infrastructure verification requirements.
Do not roll back this protection to permit destructive audit cleanup.

Executed correction evidence: `node "$env:TEMP/cp-onboarding-audit-run.cjs"`
reused the isolated harness with Jest `--testNamePattern="audit tamper"` selecting
only three new distinct cases (UPDATE, DELETE, TRUNCATE); **3 passed, 12 unchanged
cases skipped**. All 114 migrations applied as disposable setup. Each statement
rejects with SQLSTATE P0001 and the exact audit rejection message; full graph/receipt
digest is unchanged, and a freshly authorized matching retry returns the original
IDs without mutation. Catalog assertions verify BEFORE/statement/TRUNCATE flags.
Snapshots never print credentials. Test-only keys stay in memory; no real signing
or provisioning occurred. Existing 19 offline and 12 PostgreSQL cases remain prior
evidence, not reruns or additional cases in this correction.

`NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/bin/tsc --noEmit`
passed. Prisma schema/client are unchanged; prior validation reused, no regeneration.
Focused migration/source review confirms only the additional trigger, not complete
historical schema-to-SQL equivalence. Cleanup verified label/name and exclusively
owned tmpfs for `cp-verification-ffbb3c8d5731`, removed it and confirmed absence;
no volume/bind storage or existing services used. Real key registration/credential
handoff, deployment and privileged-database protections remain unverified.

Baseline: `1d01f19a3aa7ffa1096ab419144c01d60e6e73e0`.

Owner clarification in this batch approved the signed-permit contract and exact
six-key profile below. Real key registration and review/signing of a concrete
intent have NOT occurred. The internal mechanism is implemented; there is no
public enrollment endpoint or operator CLI accepting arbitrary grants.

## Bounded execution plan (before implementation)

1. Align package.json and lockfile root Node engines with README's
   `>=22.12.0 <23`. Inspect Docker/CI; retain Node 22 floating tags and report
   their unverified patches. No install, deployment or image verification.
2. Replace broad ERP/support bootstrap scripts with an import-safe denial and
   route both source and compiled npm aliases through it. Remove documented
   executable legacy guidance. Preserve history, dirty dist and existing grants.
3. Prepare strict normalized onboarding intent parsing, with stable operation
   identity and no caller grants, ownership IDs or credential fields. This is
   preparation, not operator verification or a provisioning service.
4. Enable transactional provisioning only after explicit operator and ceiling
   decisions. Until then, no HTTP endpoint, CLI provisioner, schema receipt,
   tenant/user creation or fabricated operator authority. Record the exact
   remaining contract and PostgreSQL acceptance criteria below.
5. Run focused offline boundary/runtime tests and final no-emit; review explicit
   scope/whitespace/secrets, checkpoint locally and update dashboard. Reuse
   unchanged schema/session/Prisma evidence. No unrelated database/test campaign.

Plan update after owner decisions: implement the internal verified-permit
transaction and additive receipt/audit constraints, then test with synthetic keys
and disposable PostgreSQL. Keep real registration/signing/invocation unconfigured.
Final review added an opaque credential commitment to the signed intent; rerun
affected cases without counting repeat passes as additional distinct cases.

## Confirmed baseline source and authority gap

`bootstrap-erp-access.ts` previously loaded dotenv/Prisma on import, created
CP_ROOT without tenant ownership, reused any matching email, created a global
system/owner role, granted all stored permissions and activated memberships.
It was neither atomic nor durably idempotent/audited. `bootstrap-support.ts`
selected CP_ROOT or a supplied company without verified context and seeded
configuration; it depended on that broad bootstrap. Permission catalog seeding
does not establish grant eligibility. No bootstrap is executed in this batch.

Tenant/User/CompanyMembership/TenantMembership and company-local Role already
support the target creation graph. Current login requires populated active
bridges and exact eligible selection; an existing user email is globally unique.
Current delegation mutation paths are contained, not an implemented ceiling.
Existing audit models concern authenticated sessions/credentials or finance;
none authenticates a new provisioning operator. Do not fabricate a human actor
or use a finance audit as generic operator authority.

## Owner-approved contract and remaining operational prerequisites

Owner responses approved the first two rows. Activation delivery remains an
external prerequisite, not a built-in invitation/password-email workflow.

| Contract | Approved mechanism / delivery proposal | Outstanding prerequisite |
|---|---|---|
| Operator identity and revocation authority | Sole separate provisioning subject `cargopilot-bootstrap-owner`; one explicitly registered Ed25519 key. Owner revokes via controlled out-of-band registry update. Permit binds operation UUID, intent fingerprint, approved profile revision, key fingerprint and issue/expiry times. Maximum TTL five minutes; future issue skew ≤30 seconds. Current key eligibility reloaded before receipt access, after waits and before creation. | No real key/default registry is installed; no tenant-admin token, database login or local process presence is authority. |
| Initial administrator grants | Approved immutable `initial-operational-admin.v1`: organizations.read, customers.read, customers.write, shipment.view, shipment.create, notifications.read; exact new company scope. Role is non-system/non-owner. No delegation, finance, checker, platform, policy.override or catalog expansion. | Invitations/delegation/role management remain disabled. Missing prerequisite capabilities/configuration reject; no grants added to make dependent workflows pass. |
| Activation and delivery | Controlled offline prepareOnboardingCredential validates ≥12 trimmed characters, ≤72 UTF-8 bytes and no controls, then produces a bcrypt cost12 hash and opaque SHA256 commitment. Commitment is signed; hash travels privately and is persisted only as User.password. Creation requires the matching hash; confirmed retry may omit it, but substitution rejects. | No public operator CLI, email delivery, invitation or forced-first-use-rotation gate implemented. Real deployment requires approved secure credential handoff; entropy/real recipient verification unproven. Never commit/log hashes or plaintext credentials. |

Intent v1 proposes operation UUID, explicit tenant code/name, new company
code/name, new admin email/name, requested profile revision, opaque credential
commitment and bounded reason.
Canonical UUID/email/codes and whitespace are normalized; strict objects reject
extra role, tenant IDs, ownership, status, financial and password fields.
CP_ROOT is reserved. Names/hierarchy never determine ownership. Hash the
canonical non-secret intent, not a plaintext password. Parsing/fingerprinting
alone is not authorization. The hash/plaintext remain outside public intent and
receipt; its opaque commitment is included so the signature rejects credential
substitution. Matching retry may omit the hash; if supplied it must match exactly.
A newly signed changed commitment conflicts with the original operation, rather
than resetting credentials. Salted hash preparation happens once per immutable
intent; never regenerate it for an ambiguous retry.

## Implemented atomic mechanism / scope

New additive TenantOnboardingReceipt is both the durable receipt and immutable
accepted operator audit fact. Unique operation identity, operator/key/profile/
intent binding, unique result IDs, compound company/user/tenant/membership/role
targets and immutable UPDATE/DELETE trigger. Tenant/company codes and email
uniqueness protect competing different IDs; a common normalized-email advisory
lock and case-insensitive lookup reject existing mixed-case identities.
Do not adopt any existing email; verified identity linking is a separate contract.
Fresh operator verification precedes receipt access. Matching committed retry
returns only original authorized IDs; conflicting operator/profile/content rejects.
The operation UUID transactionally consumes the permit's accepted identity;
matching renewed valid permits retain the original key/profile/content binding.
Lock the operation in the same bounded transaction; atomically
create Tenant, company Organization, new User, active tenant/company memberships,
explicit non-system company Role/approved RolePermissions, exact company scope,
receipt/operator audit. Do not create CP_ROOT, legal-entity finance
settings, ledger, checker or global roles. Any missing catalog key rejects rather
than creating arbitrary grants. No network inside the transaction.

PostgreSQL tests use actual implementation/current authorization: successful
synthetic graph and first login; exact single-company selection; no foreign or
forbidden grants; same-ID matching/conflicting retries; concurrent same/different
IDs/email conflicts; invalid/revoked/expired operator; rollback leaves no tenant,
identity, role, membership, receipt/audit business fact. Security rejection evidence
may persist separately. Real operator key/credential delivery remains a distinct
verification boundary. Synthetic signing keys never leave test memory; temporary
registry files hold public keys only. Evidence/results are recorded below.

## Compatibility, rollout and rollback

Legacy ERP and support npm bootstrap aliases now fail before configuration,
credentials, database access or writes. Direct source imports are likewise safe.
Historical migrations/audits and existing grants are unchanged. Previously emitted
dirty dist is preserved: directly executing old dist bootstrap binaries is unsafe
and must cease; new source must be reviewed/built before rollout. No artifact
provenance or deployed enforcement claim. Bootstrap is not automatic startup.
Administrative HTTP enrollment/delegation denial and ordinary login remain intact.
Rollback retains denial or disables affected operations; never restore broad grants.

Actual synthetic administrators have the exact six permissions: owned-company
organization/order reads, tenant-scoped customer/address read/write, authorized
ordinary shipment creation and own notifications, all subject to current scopes/
workflow guards. They cannot invite, edit roles, provision warehouses/assignments,
approve tariffs/prices/billing, issue invoices, post finance or become checkers.
Shipment creation may use already approved pricing through shipment.create, but
this profile cannot configure/approve pricing or restore payment/accounting paths.

CustomerEntity/Address ownership is tenant-level, not company-level. Existing
customer access resolves fresh selected company membership plus customer action
and object scope; company-scoped customers.read/write can see the tenant customer
master without a customer-link restriction. A later company in the same tenant
may therefore access that master subject to its actual grants/scopes. No fictitious
customer companyId/ownership inferred or added. Tenant separation remains enforced.

Receipt retries require fresh operator/key/permit and current active target tenant/
company/membership tuple; they never reactivate suspended results. Registry revocation
is checked repeatedly, but out-of-band file updates are not a PostgreSQL transaction:
an update after the last verification can race commit. No immediate cross-process
revocation guarantee. Restrict registry directory ACLs, stop provisioning before
key retirement, and do not run incompatible old bootstrap writers.

## Local key and registry ceremony — instructions only, NOT executed

1. Installation owner creates an exclusively owned local key directory with
   inherited ACLs removed and access limited to that owner (and necessary OS
   administration). Windows file `mode:0600` alone does not secure ACLs. Do not
   place private keys in the repository, sync folder, logs, command arguments or
   reports. Verify ACLs manually before proceeding.
2. Run this offline Node example in that protected directory, after explicit owner
   authorization. It refuses to overwrite files and prints only the public SPKI
   SHA256 fingerprint. Do NOT run it as part of onboarding/CI/application startup.

```js
// Save/run locally outside Git; current working directory must have verified ACLs.
const fs = require("node:fs"), crypto = require("node:crypto");
const pair = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync("operator-private.pem", pair.privateKey.export({type:"pkcs8",format:"pem"}), {flag:"wx",mode:0o600});
fs.writeFileSync("operator-public.pem", pair.publicKey.export({type:"spki",format:"pem"}), {flag:"wx",mode:0o600});
console.log(crypto.createHash("sha256").update(pair.publicKey.export({type:"spki",format:"der"})).digest("hex"));
```

3. Verify the fingerprint out of band. Register only the public PEM in an owner-
   controlled file outside Git, with strict keys: version=1, enabled=true,
   operatorId=cargopilot-bootstrap-owner, profileRevision=initial-operational-admin.v1,
   revoked=false, keyFingerprint=<verified SHA256>, publicKeyPem=<public PEM>.
   Protect file AND parent directories against tenant/process-user replacement;
   no symlink registry. Set absolute deployment-controlled
   CARGOPILOT_ONBOARDING_REGISTRY_PATH only after authorized registration. No
   default path, discovery, tenant API or first-key trust exists.
4. Owner reviews concrete canonical normalized intent AND all six profile keys.
   Create a fresh permit with version/operatorId/keyFingerprint/operationId/
   intentFingerprint/profileRevision/issuedAt/expiresAt in exactly
   canonicalOnboardingPermit's representation, then sign those UTF-8 bytes with
   Ed25519; encode the 64-byte signature as canonical base64. Signing is a manual
   approval act; do not implement an automatic request-signing service. Keep the
   initial password/hash out of the permit, receipts, console and command arguments;
   prepare the hash once with prepareOnboardingCredential, include only its opaque
   commitment in intent, and carry the hash privately through the approved operator
   integration/handoff. Never regenerate it for an ambiguous retry.
5. Invoking the internal onboardTenant mechanism against a real database requires
   separate explicit service/database authorization and compatible source rollout.
   This batch provides no real registry, signing invocation or real connection.
   For revocation, owner stops provisioning and sets revoked=true or enabled=false
   out of band. Tenant admins cannot maintain this trust registry.

## Focused evidence / deployment boundary

- `node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/security/tenant-onboarding.test.ts`: **19 distinct offline cases passed**. Actual Ed25519 signing/verification with in-memory test-only private keys, public registry rejection, strict normalized input/forbidden fields, bounded expiry/profile denial, credential commitment/substitution and preparation bounds, legacy no-service startup/import and aligned Node range. Initial18 and final19 are not summed. No network/real operator ceremony.
- `node "$env:TEMP/cp-tenant-onboarding-run.cjs"`: reused existing disposable
  harness with only new suite selected; **113 migrations applied**, **12 distinct
  PostgreSQL cases passed**, 30.659s final suite. Real service, actual transaction/
  grants and current login/access resolution; concurrent four matching requests
  and competing different IDs/email, confirmed retry/lost response, conflict,
  mixed-case identity rejection, forged/revoked/profile/suspended result rejection,
  injected final audit insertion rollback, immutable audit and six independently
  substituted owner/user/bridge/role references requiring SQLSTATE23503.
  Negative FK fixtures have no prior receipts, preventing uniqueness from masking
  compound FK errors; seven deployed FK names checked against schema maps.
  The earlier12-case pass was repeated after signed credential commitment was added;
  this is12 distinct cases, not24. Final retry also rejects credential substitution.
- First PostgreSQL attempt applied 113 migrations but executed **zero cases**:
  test compilation expected accessToken rather than actual login token. Test-only
  contract correction, no product/token change or weakened assertion. First
  cp-verification-a49a194f4604, pre-correction cp-verification-f88fe6d0809a and final
  cp-verification-94f9cab24196 resources
  removed after exact label/name/tmpfs/no bind-or-volume checks; absence verified.
  Loopback-only, synthetic credentials, cached image/no pull, 512MiB/1CPU/128PIDs,
  pool and statement/lock/transaction/process deadlines. Only owned temporary
  public registry files/directories removed; test private keys never persisted.
- `node "$env:TEMP/cp-prisma-offline-check.cjs"`: schema syntax/relations validated
  and ignored Prisma7.10 client generated with network and dotenv loading blocked.
  Focused manual new schema/SQL correspondence and actual compound FK evidence;
  no complete historical semantic-equivalence certification.
- No-emit default heap initially failed at 2GiB; bounded 4GiB retry exposed the
  same test-field typo, now corrected. Bounded 4GiB no-emit passed for final
  credential contract; final bootstrap packaging check recorded at checkpoint.
  Docker/CI unchanged; no new image/build verification claimed.
- Reused unchanged authentication negative/concurrency/revocation, pricing,
  workflow, dependency, Prisma runtime and transport evidence only for unchanged
  behavior. No public HTTP flow, Redis, real signing ceremony/credential delivery,
  device, S3/provider or deployed database certification. No existing DB touched.

Migration must precede calling new service; stop old broad bootstrap binaries,
catalog/grant writers and incompatible provisioning before rollout. Do not deploy
dirty dist: produce separately reviewed source-derived artifacts. Missing registry,
disabled/revoked entry or unsigned/unapproved intent fails closed before DB access.
Schema privileges/ACLs, real signing/credential handoff and secure operator invocation
need external authorization/verification. No invitations, management mutation,
second-company onboarding or existing-email binding restored by this foundation.
Dependency findings remain full8/production5 from unchanged selected package tree;
only root engine metadata changed, so no new audit/dependency campaign was run.

Policy-blocked cleanup directory remains untouched:
`C:\Users\Anvar\AppData\Local\Temp\cp-dependency-coverage-c87e5bd06bb04137b29a246fe3601bdb`.

Final packaging review: legacy npm commands use a standalone `node -e` denial,
and source bootstrap wrappers contain import-safe standalone denial. No extra CJS
asset is required in Docker/compiled output. One affected legacy-entrypoint case
reran (18 unchanged skipped); it is not a20th distinct case. Final
`node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit` passed
after that correction. Source schema/migration, strict intent and cryptographic
authority, fresh receipt eligibility, six-key grants, atomic rollback and response
projection reviewed. Exact staged scope/whitespace/targeted secrets checked before
local checkpoint; no dependency nodes or existing output rebuilt/modified.
