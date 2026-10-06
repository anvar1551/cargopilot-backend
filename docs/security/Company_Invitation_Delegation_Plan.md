# Company invitations and operational delegation — bounded plan

Baseline: `87da9b7ae3830bd69db425b09ee7c1d264674a94`.
Status: approved execution plan; validation/checkpoints recorded separately below.
The owner explicitly approved the three operational profiles below and the bounded
initial-authority contract, and then explicitly deferred driver profiles. No profile
name, permission possession or existing owner role proves delegation authority.

## Current source and uncovered contract

`identity-access/application/managementAccess.ts`, `iam.service.ts`,
`auth.service.ts` and `transport/fastify-routes.ts` contain arbitrary enrollment,
role binding and access mutation; those denials remain. The permission catalog has
membership.invite but no separately accepted delegation ceiling. MembershipRole
and MembershipScope store effective grants, not independently accepted authority.
`tenant-onboarding.ts` accepts only signed initial-operational-admin.v1, whose
six-key allowlist and published receipt profile check must not expand silently.

HTTP authentication reloads selected membership and durable session lineage.
Socket delivery rechecks fresh membership/session eligibility and existing sockets
are swept; neither provides retroactive cancellation of effects already authorized.
Use `lockCredentialUser` and the existing refresh-context locking convention to
serialize selected-context session revocation with login/refresh. Do not rely on
process-local access-cache clearing as distributed revocation.

## Approved immutable allowlists

| Revision | Exact existing permission keys | Permitted scope shape |
|---|---|---|
| operational-clerk.v1 | organizations.read, customers.read, customers.write, shipment.view, shipment.create, notifications.read | Exact selected company |
| operational-dispatcher.v1 | organizations.read, drivers.read, shipment.view, shipment.assignCourier, shipment.custody.dispatch, shipment.custody.last-mile-offer, notifications.read | Exact selected company |
| operational-warehouse.v1 | shipment.view, shipment.custody.intake, shipment.custody.receive, shipment.custody.dispatch, shipment.custody.last-mile-offer, notifications.read | Nonempty explicit owned warehouse IDs, within actor's accepted ceiling |

Proposed driver profile was surfaced for review but is **not ready**: current
custody discovery requires shipment.view, driver eligibility requires
drivers.telemetry and local/linehaul User.driverType, and proof HTTP requires
shipment.update. The initially proposed driver keys do not satisfy these contracts.
Request a decision to defer driver grants/provisioning rather than silently adding
keys or mutating a human's shared driverType across tenant contexts. No driver
workflow compatibility claim follows from the proposed profile.

All profiles exclude cash, pricing/price acceptance, billing, finance/checker,
platform, override, integration management, delegation and arbitrary role binding.
No union with a caller-selected role or automatic dependent-permission expansion.
Company-scoped customer access still concerns tenant-owned customer masters; it
does not introduce customer-company ownership absent from the model.

## Recorded owner decisions

1. Exact clerk/dispatcher/warehouse allowlists approved. Driver enrollment/profile
   grants explicitly deferred by the subsequent owner response; no additional
   driver keys or shared driverType changes authorized by this batch.
2. Approved separate membership.delegateOperational permission plus an explicit
   durable company/membership-bound accepted ceiling. Proposed initial authority:
   installation-owner signed permit only, onboarding v2 with membership.invite and
   membership.delegateOperational, and a separately signed exact membership grant
   for existing admins. No upgrade of v1/existing administrators. Tenant delegators
   cannot create other delegators. They may manage only workflow-owned operational
   grants, never themselves or unrelated legacy roles/global user suspension.

## Bounded implementation sequence

1. Versioned server allowlists and strict normalized input; separate immutable
   operator acceptance and company-bound ceiling. Add additive SQL/Prisma models
   for invitations, accepted authority, managed grants and append-only action
   receipts. Compound ownership/user bridges; unique operation/token/acceptance
   identities; BEFORE UPDATE/DELETE/TRUNCATE audit protection. Publish no real key.
   Preserve v1; new approved v2 requires explicit registry/permit revision and new
   migration extending applicable profile constraints, never historical rewrites.
2. Protected company invitation and grant/revoke services and narrowly scoped
   HTTP endpoints, separate from disabled legacy APIs. Input includes operationId,
   exact normalized email/profile revision/typed scope IDs and bounded reason.
   Resolve actor freshly, lock/reload accepted authority and targets in transaction,
   prove warehouse tenant and actor's specific ceiling. Ownership is server-derived.
   Prohibit self changes, financial keys, delegated delegation, unsafe nested writes
   and modification of unmanaged legacy access. Record immutable actor/context,
   intent/result and authoritative time atomically with grants and session effects.
3. Invitations use 32 random bytes, SHA256 token hash, bounded expiry (proposed
   fixed 72 hours), single-use conditional consumption and transaction locks.
   Raw token is returned once to the authorized creator for controlled delivery,
   never stored in receipts/logs or published in fixtures. Matching creation retry
   returns receipt metadata, not a recoverable raw token. Lost token delivery needs
   explicit cancellation/replacement, never automatic reissue under one identity.
   No email sending. Document operator handling and accidental-token logging risks.
4. New identity establishes a bounded hashed password at acceptance, never via an
   administrator-provided credential. Existing identity must present verified
   current authentication for the normalized recipient email; token/email alone
   cannot bind it, reset password or adopt an identity. Shared email locking uses
   onboarding's convention; existing unsafe/unowned memberships reject rather than
   being silently adopted. Acceptance reloads current inviter ceiling and resource
   ownership; revoked/expired/used/conflicting requests produce no business effects.
   Return minimal confirmed membership identity; login remains the existing explicit
   selected-context flow, without granting a session from an invitation receipt.
5. Operational replacement/revocation increments a durable membership authorization
   version and revokes all live sessions for only that exact selected membership
   atomically. Preserve other-company sessions and unrelated roles. Lock identity
   before membership/refresh context in a common documented order; fresh role and
   ceiling resolution must use the transaction, not an out-of-transaction snapshot.
   Existing HTTP session checks/socket sweep/protected-delivery checks consume that
   revocation; retain and report their timing boundary. No immediate-race-free claim.

## Compatibility, rollout and rollback

New explicit API only; legacy create-user, role mutation and shared identity PATCH/
DELETE remain denied. Clients deferred. Apply additive migration before enabling
new code; stop incompatible IAM writers. No backfill or assumption that legacy
roles confer delegation. Real provisioning/secure delivery still require separate
owner registration and invocation authorization. Rollback disables new operations;
retain accepted audit/history and do not restore unscoped legacy writers.

## Focused completion evidence

Offline cases: strict input, fixed ceilings, missing context/permissions, forbidden
keys, self grants, normalized matching/conflicting retries and secret-safe responses.
One bounded disposable PostgreSQL run: two tenants/companies, separate administrators
and recipients, owned/foreign warehouses; new enrollment/login, authenticated
existing-user binding, ceiling and scope denials, expired/reused tokens, concurrent
acceptance, revoked inviter, grant/revoke conflicts and injected rollback. Assert
final grants, single receipts and unchanged business graphs on rejection. Exercise
actual HTTP and socket revocation against changed membership; distinguish mocked
from real transport/database evidence. Final no-emit/schema checks as affected.
Reuse unchanged logistics/finance evidence; no live invitations or existing services.
Review exact staged scope/secrets/whitespace, checkpoint coherent milestones locally,
update readiness/backlog and stop after this finite batch.

## Focused external-review correction plan — 2026-10-06

Baseline 9b7c4d4e379a38525698db03fcb22fb4ef624b05. Confirmed defects:
acceptance uses a pre-authority invitation snapshot and ignores the conditional
UPDATE count; replacement checks requested scopes but not removed managed scopes.

Keep the preliminary lookup as a routing hint. Following existing identity locks,
serialize acceptance/cancellation/owner revocation through inviter membership then
accepted authority then invitation row. Reload invitation state under FOR UPDATE;
require one pending-to-accepted row or roll back every enrollment/audit effect.
Validate removed enabled managed scopes and proposed replacement under the same
actor/target locks; keep unrelated-role checks and write-free authorized receipts.
No schema, permission/profile, public API or delivery-policy expansion. Rollback
must keep affected operations disabled rather than restore the unsafe race/ceiling.

Add deterministic barriers around actual Prisma/PostgreSQL calls, cancellation
and acceptance winners, owner revocation, zero-row rollback, distinct same-company
warehouse ceilings and authorized replacement/receipt retries. Run only affected
PostgreSQL cases using the existing disposable harness plus final no-emit checking;
reuse unchanged onboarding/logistics/finance/schema/transport evidence. Review
explicit staged scope/secrets/whitespace, update evidence and commit locally.
