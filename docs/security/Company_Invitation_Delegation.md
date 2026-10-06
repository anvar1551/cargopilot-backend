# Company invitation and operational delegation foundation

Baseline `87da9b7ae3830bd69db425b09ee7c1d264674a94`.
Approved profile keys and scope shapes are listed exactly in
[Company_Invitation_Delegation_Plan.md](Company_Invitation_Delegation_Plan.md).
No driver, cash, pricing/billing acceptance/approval, finance/checker, platform,
override or integration-management profile is added. Clients remain deferred.

## Authority and real provisioning limitations

New `initial-operational-admin.v2` has the original six v1 permissions plus
membership.invite and membership.delegateOperational. V1 is unchanged and existing
admins are not upgraded. V2 creates company-bound CompanyDelegationAuthority and
an immutable owner acceptance journal atomically with onboarding. Empty initial
warehouse ceiling permits clerk/dispatcher, not warehouse invitations.
Warehouse grants require an exact owner-signed ceiling containing those IDs.

`authorizeCompanyDelegator(db, {intent,permit,signature})` is an internal-only
controlled owner mechanism, with no HTTP/queue/signer/CLI route. Exact strict intent:
operationId, membershipId, action (operator-authorize/operator-revoke), warehouseIds
(<=20), ceilingRevision=operational-delegation.v1,
profileRevision=initial-operational-admin.v2, reason. Signing fingerprint is
delegationFingerprint("operator-authority", parsedIntent), using the existing
canonical bounded permit contract and explicitly registered v2 public registry.
Only active, tenant/company-consistent company-scoped non-system/non-owner targets
can be authorized. Record owner/key fingerprint, intent and result immutably.
Owner revocation disables authority, cancels its pending invitations, bumps that
membership's authorization version and revokes its sessions atomically.

Actual public key registration, signing a real intent, private credential delivery
and real DB invocation remain unperformed and require separate authorization.
No default key, tenant-controlled trust registry or automatic permit signing.
Registry change after final verification can still race commit as documented in
Tenant_Onboarding_Foundation.md. Database owners can disable/drop journal triggers;
no absolute administrative tamper resistance claim.

## Explicit API contracts (under /api/auth)

All new routes set Cache-Control: no-store and bound bodies to 8192 bytes. Strict
allowlists reject tenant/company/role/permission/status/nested-Prisma input fields.
Actor identity/context is server-verified and reloaded in each transaction. Fresh
business permission without an accepted durable ceiling is insufficient.

| Method/path | Input | Result/authority |
|---|---|---|
| POST /company-invitations | operationId, email, profileRevision, warehouseIds, reason | Selected active delegator needs membership.invite **and** membership.delegateOperational; receipt metadata plus one-time token only on initial creation. |
| POST /company-invitations/cancel | operationId, invitationId, reason | Same fresh accepted inviter; own company and own issued pending invitation only. Matching cancellation returns original result. |
| POST /company-invitations/accept | token, operationId; new identity also name/password | Pending recipient-bound single-use token. Existing identity must send its valid current Bearer access token and omit name/password. No session issued. Returns user/tenant/tenantMembership/company/companyMembership IDs. |
| POST /company-operational-grants | operationId, membershipId, action=grant/revoke, profileRevision, warehouseIds, reason | Accepted selected-company delegator; only non-self workflow-managed operational target. Returns target membership, action and profile revision. |

Profiles clerk/dispatcher have an empty warehouseIds input and exactly selected
company scope. Warehouse profile requires nonempty explicitly owned warehouse IDs
in the accepted ceiling and has warehouse scopes only. No company-owner relation
is invented for warehouses: their authoritative owner is tenant. Customer masters
likewise remain tenant-owned and preserve existing object policy.

Token: 32 cryptographically random bytes, base64url, SHA256 stored hash, server
72-hour expiry. Never store or log raw tokens/credentials in receipts. Creation
retry uses normalized email, fixed revision, sorted/deduplicated scope IDs, selected
actor context and reason; conflicts reject. Matching confirmed retry returns original
metadata **without the token**. There is no recoverable token at rest: loss before
secure handoff requires explicit cancellation and a genuinely new invitation intent.
No SMTP/email delivery exists. Authorized staff must use an approved private delivery
channel and must not paste tokens into logs, URLs, analytics or reports. New secrets
are never committed fixtures; test signing keys stay in memory.

New identity requires >=12 trimmed password characters, <=72 UTF-8 bytes and no
controls, bcrypt cost12. Existing email is not an identity binding: existing users
must authenticate their exact identity with current signed session/context. Shared
password/email/name are never changed by acceptance. Existing company membership
or inactive tenant membership rejects rather than adopting legacy grants. Concurrent
new-user acceptance has one winner; another caller must authenticate via normal
login before retrying the confirmed acceptance with its original operation ID.
After a lost acknowledgement, use the established password and normal login;
do not create a replacement identity or acceptance intent automatically.
Confirmed token retries require the current authenticated recipient and original
acceptance operation ID, live inviter authority, current ownership and eligibility.
Different acceptance IDs after consumption reject. Expired/cancelled/disabled or
conflicting invitations remain denied; tokens/receipts do not grant business access.

## Atomicity and revocation

Database operation/token/email locks serialize retries/acceptance; compound FKs bind
authority, grants, invitation issuer/accepted target and audit to tenant/company/user.
Profile role definitions must match server allowlists exactly. Unmanaged roles or
scopes on a managed target reject rather than being silently removed. No self change
(including another membership of the same user), delegated delegation, cross-company
mutation or shared-user suspension. Grant/revoke changes, authorizationVersion,
selected-membership live-session revocation and append-only action audit commit or
roll back together. Existing company grants/sessions in other contexts remain intact.
No external effect, email job or notification is initiated by these mutations.

Acceptance audit records both the authorizing inviter and actual recipient identity;
it does not impersonate the inviter as the recipient. Accepted operation IDs preserve
the original results without resetting state; a historical result is not a claim of
current access. Fresh authorization always precedes receipt retrieval.

HTTP rechecks durable session lineage/current context; existing sockets recheck on
protected delivery and bounded 5-second sweep batches. Cross-process checks use
PostgreSQL, not process-local cache clearing. A sweep can take multiple ticks at
high connection counts; database failure denies protected delivery. Requests/effects
already authorized before revocation commit can race that commit. Neither immediate
revocation of every concurrent action nor exactly-once external/socket delivery is
claimed. Login/refresh serialize on identity/context locks with changed grants.

## Rollout and unavailable workflows

Apply the new additive migration before v2 or invitation/grant execution. Do not
rewrite published migrations, backfill grants or upgrade v1 profiles. Permission
catalog provisioning maintains keys only, never implicit role expansion. Stop old
IAM writers; legacy create-user/role/PATCH/DELETE routes remain deliberately denied.
Rollback disables these new operations and preserves accepted audit/security controls.

No real invitation delivery, frontend selection/admin UI or driver provisioning.
Financial delegation needs a separate independent-approval policy/workflow and
remains unavailable. Warehouse provisioning/assignment, legacy grant certification,
operator-management UI and credential recovery are outside this batch. Existing
nullable/historical, Redis/provider/S3/device/deployment release gates remain open.

## Executed evidence — 2026-10-05

- `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/security/operational-profiles.test.ts tests/security/tenant-onboarding.test.ts tests/security/delegation-containment.test.ts`: **55 passed** (8 new pure-profile cases, 19 affected onboarding/cryptographic cases and 28 legacy-containment/mock HTTP cases). The shared onboarding verifier and route module changed, justifying these focused regressions; no logistics/finance campaign.
- `node "$env:TEMP/cp-company-delegation-final-run.cjs"`: **20 distinct cases passed** against the final combined schema, using the actual services, transactions and authorization. **115 migrations** applied as isolated setup. Covers v1/v2 separation, owner authorization, new/existing-user binding/login, normalized retries/conflicts, one-winner concurrent acceptance, concurrent matching grants, exact warehouse ceilings, foreign/missing/self/forbidden/unmanaged contexts, expiry/cancellation/owner revocation, UPDATE/DELETE/TRUNCATE rejection, credential preservation, rollback and authoritative grant/version/session invariants. Wrong recipient audit reference rejects with SQLSTATE23503 and the exact compound constraint name; whole graph digests stay unchanged on rejection.
- Real Fastify injection uses actual invitation routes and authentication with PostgreSQL, including sanitized error/no-store checks. Rate limiter uses an explicitly injected bounded in-process **test shared store**, not real Redis. Initial acceptance HTTP case correctly returned503 with unavailable shared store; only fixture configuration was corrected, not production fail-closed policy.
- One of those20 cases connects to actual Socket.IO in **two isolated Node processes** over loopback WebSocket; controlled revocation disconnects both existing sockets. Others verify HTTP401 after grant change, retained other-company access/refresh for the same human, valid rotated predecessor access for acceptance, and successor logout rejection. No real deployed transport or universal zero revocation-window claim.
- `node "$env:TEMP/cp-prisma-offline-check.cjs"` validated schema and generated only ignored Prisma7.10 client with network/dotenv blocked. Final additional recipient relation validated with `node "$env:TEMP/cp-prisma-offline-validate.cjs"`; no new client-facing relation is used by this implementation. Focused source/SQL review verifies fields, compound targets and selected guards; SQL-only checks/triggers and extra direct restrictive FKs are deliberately retained. This is not complete historical semantic schema/migration equivalence certification.
- Final `$env:NODE_OPTIONS='--max-old-space-size=4096'; node node_modules/typescript/bin/tsc --noEmit` passed. No emitted application output, dependency changes or existing service access.

Earlier12-case run, final-schema16-pass/one-HTTP-fixture-failure run and targeted
HTTP/identity/constraint/context reruns are **not added** to the20 distinct final
cases. Type/syntax fixture errors were corrected before successful runs. The
initial cross-company test expected a foreign-context error from the same human;
the earlier self-change guard correctly rejected it instead. Final test asserts
both that denial and a separate foreign actor's exact foreign-target denial,
preserving no-effect assertions. No security checks/assertions weakened.
The affected earlier v1 onboarding15-case PostgreSQL regression passed; final20
independently covers the final schema's v1/v2 boundary. Unchanged detailed finance,
logistics, proof, provider and infrastructure evidence is reused, not rerun.

All ten exclusively owned instances, including failed setup/test runs, were
name/label/tmpfs verified, removed and absence checked: cp-verification-f7958305e384,
cp-verification-4b756ae01e2b, cp-verification-144ab166e494,
cp-verification-4ef26ef063c6, cp-verification-00546eab6fd1,
cp-verification-7ea81dcd1ee9, cp-verification-6ae9887426b1,
cp-verification-85be77a68029, cp-verification-07a3f55f77eb and final
cp-verification-c12a0eb968ce. Cached PostgreSQL image/no pull, loopback-only random
port, synthetic credentials, 512MiB/1CPU/128PID bound, owned tmpfs/no volumes/binds;
per-command and suite deadlines retained. Temporary public registry files/directories
removed by test teardown; private test keys never persisted. Policy-blocked cleanup
directory untouched. No real keys, invitations, delivery or deployment performed.

Final LF-normalized exercised source/schema/test digest (11 paths):
`d30edd7ed0d59c2bb65a5a6b11da21f5d2db729f4bc72d86a02721570492c7a4`.

## External-review correction — 2026-10-06

Baseline `9b7c4d4e379a38525698db03fcb22fb4ef624b05`. Both findings were
confirmed against current source, not inferred from the target architecture.
Acceptance formerly made its state decision from the token lookup preceding the
inviter authority lock and ignored the final pending-transition count. Replacement
formerly checked new scopes without checking the enabled managed scopes removed.

Acceptance's first lookup is now routing-only. After existing identity/lineage
checks, acceptance locks inviter membership then accepted authority then reloads
and locks the invitation. Cancellation uses that same membership/authority/row
order; owner revocation explicitly locks authority before cancelling pending rows.
A cancelled/expired/conflicting invitation cannot enroll from a stale snapshot.
Exactly one pending-to-accepted UPDATE is required; zero affected rows abort all
identity/membership/role/scope/session-version/audit changes. Accepted retries still
require current recipient authentication, inviter authority/ceiling and eligible
accepted membership; receipts grant no authorization.

Replacement verifies the actual managed scope shape and the actor's ceiling over
both the enabled existing grant and proposed new grant under target/authority
locks, before deleting scopes/roles. A-only authority cannot remove B-only access
by replacing it with clerk, dispatcher or A-only warehouse access. Disabled grants
have no removed scopes. Write-free matching receipts preserve existing fresh
context/authority/proposed-ceiling checks; they do not reapply the operation.
Unrelated-role protection remains intact. No API, profile, schema or policy change.

Focused test barriers pause actual Prisma SQL results, not fabricated results.
Cancellation can commit after initial lookup; the acceptance-winner case also
observes PostgreSQL blocking through pg_blocking_pids before releasing commit.
A test-only trigger suppresses the final UPDATE to prove complete rollback on
zero-row transition. Same-company administrators have distinct explicit warehouse
ceilings; whole-graph digests include grants/scopes/versions/sessions/audit. No
real tokens, credentials or private keys are persisted in test reports.

Validation results and owned cleanup are recorded below after execution. Existing
onboarding cryptography/profile, logistics/finance, schema and two-process socket
transport evidence remains reused where unchanged. No zero-window revocation,
production provisioning, delivery integration or historical certification claim.

### Correction validation and cleanup

- `node "$env:TEMP/cp-company-delegation-correction-run.cjs"` passed **22 selected
  PostgreSQL cases: 9 new correction cases and 13 affected regressions**; 7 unchanged
  cases skipped. Jest suite time150.099s. The existing harness applied115 unchanged
  migrations as disposable setup, then ran the actual delegation implementation.
  Pattern: `review correction|new enrollment/login|existing recipient|concurrent token|profile replacement|injected accepted|grant and revocation|missing context|authenticated acceptance|expired|cancelled|revoked-inviter|concurrent matching`.
- New evidence: cancellation wins after initial lookup; acceptance wins with a
  PostgreSQL-observed blocked cancellation; owner revocation wins; suppressed
  conditional UPDATE rolls back all enrollment effects; matching acceptance
  receipts recheck logged-out recipients/revoked inviters; three A-only replacement
  denials; authorized replacements to all three approved profiles with unchanged
  matching-retry graph. No mocked database results or external business effects.
- Affected existing cases cover actual HTTP, existing-user credential binding,
  concurrent acceptance/grants, expiry/cancellation/revocation, immutable retries,
  unmanaged targets and audit-failure rollback. No new real Socket.IO run: prior
  two-process transport evidence reused; production Redis remains unverified.
- Final `$env:NODE_OPTIONS='--max-old-space-size=4096'; node node_modules/typescript/bin/tsc --noEmit`
  passed with all final source/tests. Earlier no-emit also passed; the final run was
  needed because the receipt-authorization regression was added after it started.
  No schema/dependency changes: unchanged offline schema/client and unrelated
  onboarding, logistics and finance evidence reused, not rerun.
- One owned instance `cp-verification-8ac2d3a9f269`: cached PostgreSQL16 image/no pull,
  loopback random port, synthetic credentials,1CPU/512MiB/128PID, owned268MiB tmpfs.
  Name/run label/storage verified before removal; absence checked after removal.
  Existing command/suite deadlines retained; test barriers5s, lock-observation
  polling bounded to50 attempts. Public test registry removed; no private key
  persisted. Existing dist and policy-blocked cleanup untouched.

No permission/ownership policy expansion, API format change, real invitation,
registration/provisioning, production migration or deployed verification. Existing
revocation windows, delivery/client/driver/financial/historical release gates stay
open. These are targeted corrections, not a new complete security certification.
