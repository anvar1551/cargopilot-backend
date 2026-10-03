# Tenant-bound login and refresh session slice

## Enforced behavior in this slice

After credentials are verified, login resolves an active `CompanyMembership` for
that user and verifies its populated tenant bridge, active `TenantMembership`,
active `Tenant`, active company, and any selected branch. The company,
membership and tenant identifiers must agree. A selector is never trusted as
authority and no membership is selected by row order.

When exactly one eligible company membership exists, login selects it for
existing-client compatibility. When multiple memberships are eligible, login
returns HTTP 409 with `code: "MEMBERSHIP_SELECTION_REQUIRED"` and the verified
membership choices. Each choice contains only `companyMembershipId`,
`companyName` and `tenantName`. No access token, refresh token or
refresh-session row is created. The client repeats login with the same credentials and either
`companyMembershipId` or the compatibility alias `membershipId`. Supplying both
with different values is rejected.

Successful responses retain `token`, `refreshToken`, `accessTokenExpiresInSec`
and `user`. Existing `user.membershipId` and `user.companyId` remain present.
The response also includes `user.companyMembershipId`, `user.tenantId` and
`user.tenantMembershipId`.

Access-token claims and stored refresh sessions bind the user to
`tenantId`, `tenantMembershipId` and `companyMembershipId`. Refresh tokens also
carry the selected company context. Rotation reloads that exact membership and
rejects suspended, inconsistent, revoked, expired, mismatched and legacy
unbound sessions. Rotation cannot choose another membership.

HTTP and Socket.IO authentication require all bound claims and reload the
current selected membership. Socket.IO role and permission derivation uses only
that membership instead of combining all memberships for the user. The selected
tenant and company membership identifiers are retained in server-side socket
state.

The access-snapshot cache is keyed by user and company-membership identifiers,
and cached values must also match the expected tenant and company context. HTTP
authentication and new Socket.IO connections bypass the cache and reload the
current membership. Administrative membership, role and scope mutations in this
service clear all local cache entries for the affected user. Other writers and
other application processes do not receive distributed invalidation. Cached
authorization helpers can therefore retain prior data until their local entry
expires: 120 seconds by default, configurable from 15 to 120 seconds. Invalid
TTL configuration falls back to 120 seconds.

## Compatibility and remaining boundaries

The current frontend and driver login screens submit only email and password.
They remain compatible for users with exactly one eligible company membership
only after that membership's complete tenant bridge has been provisioned.
Neither client currently handles the 409 selection response or submits a
membership selector, so multi-membership users cannot complete login until
those clients add an explicit selection step. Existing unbound access and
refresh tokens require a fresh login.

The frontend consumes `token`, optional `refreshToken`, and `user`; it preserves
the legacy `membershipId` and `companyId` fields but currently drops the new
tenant context fields when normalizing the locally stored user. The driver
requires `token`, `refreshToken`, and `user` at login and stores the returned
user object without a typed tenant-context contract. Both refresh clients accept
the rotated `token`, `refreshToken`, and `user` returned by this slice.

Socket.IO delivery rooms bind tenant, company membership, company and user.
Order-update and driver-notification emitters reload the referenced order and
derive tenant and company ownership from its stored `tenantId` and `ownerOrgId`.
They require the recipient to remain the assigned driver, reload that exact
membership without the access cache, and require `drivers.telemetry` before
delivery. A failed membership or permission recheck suppresses the event and
disconnects matching sockets on the current server process. Missing order
ownership suppresses both realtime notification delivery and creation of its
user-notification row. Suppression diagnostics contain only an event category
and fixed reason code and are rate-limited per process.

Unread notification counts are restored only for notifications matching the
verified recipient user, tenant, company and company membership. The HTTP
notification list/detail/read/count paths use the same context. Historical
unowned rows remain inaccessible rather than being inferred from user identity.

An already-connected socket is revalidated only when one of these protected
order events targets its context. Membership suspension, session revocation or
permission changes do not proactively find every socket, and disconnects are
limited to sockets visible to the current process. A change occurring after the
event's final membership check but before Socket.IO emits can still race with
delivery. Immediate and distributed revocation of live sockets is therefore not
established.

The driver offline proof queue is not tenant or membership bound yet. Client
work must bind queued items to the authenticated user, tenant and company
membership and prevent replay after an identity or selection change before
multi-membership driver use is enabled.

This slice does not scope business repositories by tenant, make nullable tenant
columns mandatory, backfill memberships, redesign authorization grants, or
establish complete tenant isolation. Company permissions and object scopes
remain tied to the selected `CompanyMembership`; tenant membership alone grants
no access to other companies in the tenant. Refresh rotation uses a conditional
single-row update and creates the replacement in one transaction, but concurrent
reuse behavior has now been validated for the focused disposable PostgreSQL schedules recorded below. It still does not
implement refresh-token-family reuse detection or revoke descendant sessions.
A membership-status change committed before the consuming UPDATE now prevents
rotation: that statement repeats expiry, selected-company membership, tenant
membership, tenant and company eligibility. This does not lock all membership
rows or demonstrate revocation after the statement snapshot; subsequent HTTP
authentication still reloads the membership. Concurrent logout and refresh can
also leave the newly rotated session active because logout targets only the
presented session identifier (now also bound to exact refresh purpose, hash, user and selected context; see Logout_Exact_Token_Binding.md).

## Focused PostgreSQL rotation evidence (mission continuation)

Application source unchanged at cd4a275 (session implementation originates in the prior checkpoint). Executed node "$env:TEMP/cp-refresh-disposable-run.cjs" targeting tests/security/refresh-rotation-postgres.integration.test.ts: three distinct cases passed. The actual refreshUserSession, JWT signing/verification, current membership resolution and Prisma transaction run against PostgreSQL; only the application Prisma import is redirected to the owned test adapter and Redis is disabled. A bounded test barrier admits all three callers only after they reach the real transaction boundary, ensuring the old session was checked by each before competing conditional updates. One succeeds, two reject, the old row is revoked and exactly one replacement preserves the exact tenant/company/membership tuple. Consuming the old token again rejects without additional rows.

A PostgreSQL BEFORE INSERT trigger injects the specific replacement failure; the old session row and session count remain unchanged, then a confirmed retry succeeds after removing the test-only trigger. A suspended membership rejects without consuming or creating sessions. This is actual database evidence for these schedules, not a token-family design or proof of all revocation races. No auth source or client behavior changed; unchanged mocked suites were not rerun. node node_modules/typescript/bin/tsc --noEmit passed for the added integration test.

The reused runner created only cp-refresh-rotation-6bc6406eac88 with cached image (--pull never), synthetic credentials, an allowlisted environment, run-marker/URL guards, loopback port, 512 MiB memory, one CPU, 128 PIDs and 256 MiB owned tmpfs. All 72 committed migrations applied. Cleanup checked container name/run label/tmpfs/no volume or bind mounts and removed only that resource. Existing databases/containers were untouched. Three cases are counted once. Expiry/eligibility are checked before the transaction; changes during rotation and concurrent logout remain timing gaps. Token families/descendant revocation, distributed cache/socket revocation and real transport remain release blockers.

## Consumption-time eligibility correction

The preceding 72-migration evidence is historical, not a claim that atomic
rotation was missing. The current correction adds eligibility at the actual
single-use UPDATE without changing the login/refresh response, selecting another
membership, adding schema, or granting receipt access. The exact stored user,
tenant, tenant membership, company membership and company must match active
server-side relationships. Session expiry must be later than the server's
transaction-consumption time. A zero-row consume rejects before replacement
creation, and replacement INSERT failure still rolls back the old-token update.

Focused evidence and owned-instance cleanup are recorded in the backlog. The
new database cases change expiry or one of the four active ownership conditions
after real credential/session/context prechecks and before the real transaction.
They assert every session row is unchanged by the rejection. Existing actual
duplicate/rollback schedules are rerun because their consuming SQL changed.
These tests do not demonstrate token-family reuse detection, successor logout,
distributed invalidation or all concurrent revocation schedules. Status changes
after the UPDATE snapshot and expiry while the transaction completes remain
timing boundaries; access authorization must continue to fail closed independently.

Exact current validation: `node node_modules/jest/bin/jest.js --runInBand
--runTestsByPath tests/security/tenant-session-auth.test.ts --testNamePattern='refresh|failed consumption'`
passed4 (18unchanged skipped). Its delayed-exit warning was investigated by the
same affected-only command with `--detectOpenHandles`:4passed, clean exit and
no open-handle report, not4additional cases. `node node_modules/typescript/bin/tsc
--noEmit` passed. `node "$env:TEMP/cp-refresh-predicate-run.cjs"` applied95migrations
and passed8native cases (5new/3affected) in cp-refresh-predicate-890f7b9135a5.
The reused guarded runner used cached-image `--pull never`, synthetic credentials,
loopback,512MiB/oneCPU/128PIDs/256MiB owned tmpfs; exact identity/storage checks,
removal and label-filtered absence verified. No existing services were accessed.
