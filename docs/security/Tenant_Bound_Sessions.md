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

Unread notification counts remain blocked from realtime delivery because
`UserNotification` rows do not carry tenant or company-membership ownership and
the current counting query is user-global. The HTTP notification list/read/count
paths have the same ownership limitation and require a later schema and
repository cutover.

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
reuse behavior has not been validated against PostgreSQL. It also does not
implement refresh-token-family reuse detection or revoke descendant sessions.
A membership-status change between the pre-transaction eligibility read and
rotation can issue a replacement session, although subsequent HTTP authentication
reloads the membership and rejects that token. Concurrent logout and refresh can
also leave the newly rotated session active because logout targets only the
presented session identifier.
