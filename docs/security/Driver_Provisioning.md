# DOM-01 — controlled membership-specific driver provisioning

Baseline eceb4b0637a61b4ecb1dadae3973d999866866f1. Owner approved the
six-key local-driver.v1 and three-key linehaul-driver.v1 profiles, separate
owner-authorized driver-delegation.v1 ceiling, exact membership eligibility,
action-key discovery/proof and no implicit scopes. Clients remain deferred.

## Execution plan and invariants

1. Add separate driver authority/invitation/eligibility records with compound
   user/tenant/company/membership bridges and immutable accepted action evidence.
   Reuse reviewed identity locks, bounded permit verification, hashed invitations,
   receipts, role validation and selected-context revocation. No change to existing
   operational profiles, onboarding v1/v2 or their ceilings. Owner driver authority
   requires an independently registered driver-delegation.v1 registry revision.
2. Replace User.driverType authority in assignment, discovery, custody and driver
   consumers with current accepted eligibility. Managed driver snapshots have no
   implicit company scope or user-global warehouse/customer binding. Restrict
   proof/discovery to the relevant action key and preserve ordinary scoped users.
3. Type replacement blocks current assigned pickup (assigned/pickup_in_progress/
   picked_up without custody history) and latest driver-bound custody phases
   pickup-offered/transport-offered/transport/last-mile-offered/last-mile. Completed
   delivered and superseded warehouse custody do not block forever. Shared eligibility
   locks held through Order writes serialize with replacement/revocation exclusive
   eligibility locks, acquired before credential/membership locks; reject rather
   than reassign.
   Revocation remains available and retains every assignment/history. Receiving
   records the outgoing revoked eligibility with bounded reason, preserving the
   existing recovery policy; no automatic completion/cancellation.
4. Actual synthetic provisioning/login -> restricted initial pickup/proof ->
   warehouse -> linehaul -> local last-mile/proof/delivery, plus retry/conflict,
   concurrency, rollback, foreign context, type-blocker and HTTP/socket revocation
   tests. Mock storage/Redis explicitly; PostgreSQL in owned disposable resources.
   Focused affected regression, offline schema/client and final no-emit checks.

## Rollout and compatibility

Additive migration first, then compatible source; stop old driver/IAM writers.
No automatic legacy driver-type adoption. Existing User.driverType is retained as
historical data, never authority for migrated operations. Legacy driver memberships
require explicit accepted provisioning before resuming driver work. Rollback keeps
the new enforcement or disables affected operations, never restores global scopes.
Real owner keys/intents/delivery/invocations remain separately unauthorized.
No cash, finance/checker, generic shipment read/update, assignment, override or
delegation keys belong to a driver profile. No frontend/driver changes in DOM-01.



## Implemented profiles and authority

| Profile | Exact permission | Required operation |
|---|---|---|
| local-driver.v1 | drivers.telemetry | Selected-context location/presence and realtime eligibility; optional order telemetry still authorizes custody parent. |
| local-driver.v1 | shipment.changeStatus | Currently assigned initial pickup transitions only; existing cash/state guards remain. |
| local-driver.v1 | shipment.custody.pickup-offer | Exact assigned pickup handover; action-key discovery and pickup proof preflight/submission. |
| local-driver.v1 | shipment.custody.last-mile-accept | Accept exact selected-membership nomination. |
| local-driver.v1 | shipment.custody.deliver | Accepted last-mile completion; action-key discovery and delivery proof. |
| local-driver.v1 | notifications.read | Own selected-context notifications only. |
| linehaul-driver.v1 | drivers.telemetry | Selected-context location/presence and realtime eligibility. |
| linehaul-driver.v1 | shipment.custody.transport-accept | Exact nominated transfer acceptance and its custody discovery/preflight. |
| linehaul-driver.v1 | notifications.read | Own selected-context notifications only. |

Neither profile contains shipment.view/viewAssigned/update/assignCourier, cash,
finance/checker, company/warehouse scopes or delegation. Managed memberships
must have exactly the accepted profile role, zero explicit scopes and no implicit
company scope or shared User warehouse/customer binding. Exact accepted action,
active tenant/company/TM/CM and profile/permission equality are reloaded; User
classification and claims cannot establish eligibility. Corrupt/mixed grants deny.

The installation owner authorizes a separate driver-delegation.v1 record and
company-driver-delegator.v1 role (membership.invite + membership.delegateDrivers).
Only the separately registered driver-delegation.v1 permit revision can authorize
it. Its immutable intent is operationId, membershipId, action operator-authorize
or operator-revoke, profileRevisions (local-driver.v1 and/or linehaul-driver.v1),
ceilingRevision/profileRevision driver-delegation.v1, and bounded reason. Existing
onboarding v1/v2 and operational delegation never acquire this authority. Ordinary
driver grants cannot create delegators or change self/unmanaged/delegator targets.
No owner HTTP bypass or automatically trusted key was added.

## Additive HTTP contracts

All paths are under /api/auth, use bounded bodies and private no-store responses.
The service revalidates current accepted authority beyond route permissions.

| POST suffix | Strict body / behavior |
|---|---|
| /company-driver-invitations | operationId, email, profileRevision, reason. One-time random token return; hash stored, 72-hour expiry. Matching retry returns original metadata without raw token. Lost delivery needs explicit cancellation/new intent. |
| /company-driver-invitations/cancel | operationId, invitationId, reason. Only original accepted inviter authority; serialized authoritative pending-state decision. |
| /company-driver-invitations/accept | token, operationId; new recipient supplies name/password. Existing identity must present verified live authenticated email identity, never password adoption/reset. Atomic membership/profile/eligibility receipt; no session issued. Normal login follows. |
| /company-driver-grants | operationId, membershipId, action grant/revoke, profileRevision, reason. Fresh ceiling over existing and replacement managed profile; conflicts reject, matching receipt remains authorized. |

Acceptance results add profileRevision alongside user/tenant/company/TM/CM IDs.
Login/refresh selected-context fields and existing custody-work/event contracts
remain unchanged. Company user/driver directory driverType now reflects current
membership eligibility; shared User.driverType is retained historical data.
Pickup proof creation is permitted only during initial assigned/pickup_in_progress/
picked_up work without custody history. Delivery proof requires accepted last-mile
(or delivered) custody. Confirmed matching proof retries still reauthorize current
context before returning their original receipt; no new post-handover pickup proof.
PNG limits/server time/idempotency/storage recovery remain intact. Linehaul does
not obtain proof upload authority. Existing authorized non-driver callers retain
scoped behavior; generic order/proof-read APIs were not broadened for drivers.

## Replacement, revocation and concurrency

Type replacement checks authoritative same-tenant owner-company Order and latest
custody sequence. Blockers: initial assigned/pickup_in_progress/picked_up assignment
to that identity with no custody and no current warehouse; or latest exact selected
membership in pickup-offered, transport-offered, transport, last-mile-offered or
last-mile while order is not delivered/cancelled/returned. Historical superseded
warehouse or completed custody is not a blocker. No exception/return policy added.
Assignment/custody uses eligibility SHARE through the business transaction;
replacement/revocation takes UPDATE before credential locks. Both race winners
were demonstrated. Membership profile/scope changes, accepted action, version and
selected-session revocation commit together. Eligibility references its immutable
accepted action through a deferred compound FK; result/profile agreement is also
checked in application authorization. This is not protection against schema owners.

Revocation can occur during work, disables eligibility, removes the managed role,
and revokes exact selected sessions without erasing membership/assignment/custody.
Other-company identity, credentials and sessions survive. Authorized receiving
requires retained exact outgoing eligibility/identity, accepted predecessor, full
parcels, expected state and warehouse scope. Disabled outgoing eligibility requires
bounded reason recorded with immutable receipt evidence; no driver reactivation.
HTTP rejects revoked tokens; two-process connected sockets are disconnected using
existing bounded revocation sweeps. Last-check-to-effect and sweep timing windows
remain; immediate universal revocation/exactly-once transport is not claimed.

## Validation and limitations

Final combined schema: 116 migrations applied in one uniquely owned PostgreSQL16
instance; 20 distinct cases passed (14 provisioning, 6 actual-service restricted
journey/concurrency/recovery). Actual Fastify permission/token checks and actual
Socket.IO in two isolated loopback processes are included. Storage/network/Redis
boundaries in the journey are mocked; this is not a full HTTP/native-device journey.
The additional actual cash-service denial assertion reruns one existing case and
is not another distinct case. Failed setup/assertion runs were corrected, not counted.

244 distinct affected offline/mock cases passed across 15 suites: 228 existing
boundary regressions plus 16 new accepted-eligibility/snapshot tests. Targeted reruns
are not added to this count. Schema WASM validation and ignored Prisma7.10 client
compatibility generation passed with dotenv/network blocked. Focused migration/source
review checks new bridges, targets and guards; no complete historical semantic
schema/SQL equivalence claim. Final no-emit results are recorded in the dashboard.

Commands: node node_modules/jest/bin/jest.js --runInBand with the affected suites
(driver-eligibility, tenant-onboarding, tenant-session-auth, custody-work,
custody-receiving, custody-proof-preflight-http, dispatch-notification,
driver-selected-telemetry, tenant-realtime-routing, proof-upload-boundary,
driver-directory-selected, dispatch-selected-authority, dispatch-batch,
dispatch-batch-http, warehouse-custody-http); node "$env:TEMP/cp-prisma-offline-check.cjs";
node "$env:TEMP/cp-driver-provisioning-run.cjs"; affected actual cash denial rerun
node "$env:TEMP/cp-driver-cash-denial-run.cjs"; final
$env:NODE_OPTIONS='--max-old-space-size=4096'; node node_modules/typescript/bin/tsc --noEmit.
The PostgreSQL runners sanitize inherited endpoints, validate a run/database marker,
use cached image/no pull, loopback-only random port, synthetic credentials,
1CPU/512MiB/128PID and owned268MiB tmpfs, bounded tests/locks/connections. Name,
label and mount ownership checked before removal; absence verified afterward.

Deploy the new migration before compatible source/client generation and stop old
IAM/driver writers. Explicitly provision the new membership.delegateDrivers catalog
metadata using a controlled reviewed procedure before authorizing a delegator;
missing catalog entries deny, not auto-grant. Do not use broad permission/bootstrap
seeding as a shortcut. The owner must separately register the real public registry
revision, approve/sign a concrete intent and authorize invocation. None was done.
No automatic conversion of legacy User.driverType or unmanaged roles. Accepted
membership provisioning is required; migration alone does not certify old drivers.
Rollback must retain enforcement or disable these operations, never restore scope
fallbacks. Existing operational invitation contracts/profile ceilings are unchanged.

DOM-02 operational provisioning remains separate (warehouse/configuration/dispatch
capabilities, including drivers.manage vs approved drivers.read, require an explicit
contract). Synthetic operator/pricing/checker prerequisite fixtures do not prove real
provisioning of those authorities. DOM-03/05 cash remains unavailable to these
profiles; legacy cash target classification uses User.driverType and was not expanded.
Frontend/native enrollment, action-key discovery/proof/replay and device/Redis/S3
verification remain deferred. Real keys, invitation/credential delivery and production
rollout are unperformed. Preserve historical/nullable/RLS/provider/finance policy and
source-to-dist release gates. No production-readiness claim.

Final checks: no-emit exit0 after the added cash assertions. All20 PostgreSQL cases
passed in cp-verification-325cdc094df2; affected cash-denial/socket rerun passed1
with13 skipped in cp-verification-7f0c6c51ff4f. Both ownership-checked containers
and exclusively owned tmpfs were removed; absence verified. No volume/bind cleanup.
