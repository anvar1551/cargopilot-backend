# Password change and session issuance serialization

Source-confirmed gap at de419d2: password update and all-user refresh revocation
are separate writes; login checks a hash before session insertion; prechecked
refresh can race cleanup. Existing selected-context lineage locking does not
serialize these account-wide credential operations.

Bounded plan: reuse the authoritative User row as a transaction lock. Login,
refresh and password change lock that row before membership/lineage locks or
session writes. Verify the exact previously checked credential hash under the
lock for login/password change; do expensive bcrypt work before the transaction.
Password change requires fresh complete selected context, rechecks that exact
membership inside the transaction, conditionally changes its own user password
and revokes all of that human identity's refresh sessions atomically, preserving
the pre-existing account-wide logout policy. No administrative password override
or delegation eligibility is introduced. Login rechecks the chosen membership;
refresh retains its current consuming eligibility predicate.

Lock/statement/transaction deadlines2s/5s/10s with2s admission, ReadCommitted.
Lock order is User then selected lineage context then session rows. Logout takes
only lineage/session locks and never waits for a User lock; no inverse order.
Successful password changes clear local identity access cache after commit.
No new schema, migration, credential epoch or token claims. HTTP request/response
unchanged; internal password service now requires the verified actor, not a
context-free userId. Clients remain deferred. Rolling deployments require all
issuers to use the same lock; rollback must preserve locking or contain affected
issuance. Old access tokens and connected sockets are not thereby revoked;
distributed credential/session invalidation remains technically unfinished.

Acceptance: valid self-service change, wrong password/context/hash/eligibility,
transaction failure rollback, old-credential login held before transaction,
refresh and password change winning each competing schedule, competing password
changes using the same checked old hash, full financial/business snapshots
unchanged. Use affected mocks/HTTP and existing disposable PostgreSQL harness;
no existing services, dependency/client/dist edits or broad audits.

## Implemented protection and validation

All three session/credential writers now lock User first. Login reloads exact
chosen active ownership inside its issuance transaction and compares the checked
hash; refresh repeats existing consuming eligibility after the User/context
locks. Password change checks fresh selected context, locks and compares the
checked hash, reloads that membership, conditionally updates the credential and
revokes own refresh sessions in one transaction. Failed commits never clear
local access cache or acknowledge success. Hashes remain internal and are never
included in DTOs, diagnostics or reports. Sole HTTP consumer passes verified
request.user; no client API fields or response shapes changed.

Executed `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath
tests/security/tenant-session-auth.test.ts`:26 affected session cases passed.
Executed password-session-serialization.test.ts plus auth.phase0a.test.ts with
the focused password/credential/actor/locked-User/hash/membership/revocation
filter:21passed (16new unit boundaries and5affected HTTP/login/error cases),
14unrelated cases skipped. Only the affected successful HTTP fixture changed
to a valid synthetic User UUID/locked credential response; no assertion weakened.
New unit parameterization initially failed TypeScript tuple inference and the
old HTTP fixture failed before signing because it used a non-UUID User; both
were corrected before passing evidence. Final no-emit results in the backlog.

`node %TEMP%/cp-password-session-run.cjs` reused the guarded harness/full99
migrations and passed22 distinct PostgreSQL cases:16affected refresh/logout
cases plus6new credential cases. Actual login/refresh/password transactions
run against PostgreSQL, Redis disabled. An observed User-row lock wait proves
password change sees and revokes a committed successor; the opposite schedule
denies prechecked refresh. Prechecked old-password login creates no session,
three competing checked changes accept one hash transition, and injected
revocation failure rolls back the complete credential/session state. Valid
new-credential login retains selected context, other users' sessions remain
unchanged, and order/invoice/journal/outbox counts are unchanged. Not a claim
about external delivery, all revocation races or distributed access invalidation.

Owned cp-password-session-d75fab550424 used cached PostgreSQL16-alpine with
--pull never, environment allowlist, synthetic guarded loopback credentials,
512MiB/1CPU/128PIDs/256MiB tmpfs. Name/run label/owned tmpfs/no volume or bind
verified before removal; label-filtered absence and cleanup verified. No schema
changes, client generation, existing databases/services or unrelated tests.

Remaining boundaries: already issued access tokens/connected sockets can outlive
refresh cleanup; no global immediate revocation or family compromise policy is
claimed. Membership changes after the recheck statement snapshot remain a
timing boundary. Other credential writers outside these covered self-service
paths require the same serialization/revocation contract before restoration.
Protected credential-change security audit coverage remains a separate work
item; no sensitive logging was introduced.
