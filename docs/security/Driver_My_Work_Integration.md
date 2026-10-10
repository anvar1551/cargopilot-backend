# Driver My work integration — 2026-10-10

## Current result and API compatibility

The native application has one My work implementation, shared by its home, orders and detail routes. Barcode/manual search resolves only exact authorized order numbers or parcel codes through existing custody-work discovery. Old generic order/status/exception/return execution boards are replaced. Named contacts, addresses, phone/map launch controls, parcel references, proof capture and notification/profile settings are retained where authorized; completed history and unsupported exception/return actions are explicitly unavailable.

Backend additions, all authenticated and no-store:

- GET /api/orders/:id/driver-work: accepted exact selected driver membership, authoritative owned order/custody relation, current driverActions/proofStages, existing expected timestamp/event/whole-parcel fields, warehouse names and minimal operational contacts/addresses. No monetary or private configuration projection.
- GET /api/orders/:id/pickup-destinations: only current pickup-offer authority; owned tenant warehouse name/location, limit 1–20 and canonical context/order-state-bound cursor. It grants no warehouse scope. Tenant-owned locations are not given invented exclusive company ownership.
- Existing GET custody-work?kind=driver, POST driver-status, POST custody and multipart proofs/capability contracts are reused. No schema, grant, role, eligibility or workflow expansion.

An unrelated restricted driver previously reached the generic scope fallback's non-UUID no-access sentinel, causing PostgreSQL 500. Custody read now explicitly denies missing shipment.view and sentinel predicates before querying. Authorized existing scoped readers retain their policy. Initial status responses use the existing success/order envelope; the native adapter now normalizes it before local confirmation.

## Immutable intent and proof behavior

Work intents are partitioned by user/tenant/tenant-membership/company/company-membership identity, durably written and read back before send, with invocation epoch checks even while waiting for the serialized queue. They retain original operationId, order, whole parcel set, expectedEventId, expectedUpdatedAt, destination, pickupTrackingId or confirmed proofSubmissionId. No refresh interceptor automatically replays these mutations. Pending selector refresh cannot retarget saved work. Confirmed receipt verification still reaches fresh server authorization; a historical receipt does not describe current custody.

First definite non-timeout/non-rate-limit 4xx rejection is retained as rejected history, never replayed. A later rejected retry cannot clear an earlier ambiguous attempt. Custody uncertainty permits only explicit identical retries. Existing pickup status transitions have no server request receipt: their operation identity is local only and an uncertain response remains reconciliation-required, with no replay or silent replacement. There is no new abandonment/reconciliation policy. Local capacity is bounded to 100 retained work records and storage failure disables sending.

Existing native PNG conversion, bounded stroke signature rasterization, immutable file hash/submission identity and proof queue are reused. Proof preflight now calls driver-work stage authorization and the existing proof-submission capability, rather than requiring shipment.update or generic order detail. Delivery requires a locally confirmed immutable submission and is independently validated by the server. Legacy unbound proofs remain quarantined. Server receipt time remains authoritative; capture time is separate.

Service Cash is deliberately separate: saved cash intents are untouched. The native legacy collection adapter lacks the current obligation/transfer contract and is not exposed as a working cash action. Old profile Float summaries/generic cash queries no longer suggest authoritative totals. No broad shipment, cash, company/warehouse scope or shared User.driverType workaround was added.

## Executed evidence

- 22 new focused native work/adapter cases: immutable write/readback, storage failure, restart, context partitioning, invocation-context races, late response, concurrent submissions, explicit matching retries, definite versus ambiguous rejection, current proof-stage preflight, actual status-envelope normalization, no mutation refresh replay and safe error classification.
- 47 affected existing client cases executed: 24 proof and 23 session cases. One old adapter fixture was updated to the new authoritative stage response; its invalid-order/denied-actor/permission/capability assertions remain. Total distinct client cases: 69. Intermediate reruns do not add cases.
- 24 distinct affected mocked/backend service/HTTP cases across custody-receiving, custody-work, custody-proof-preflight-http and warehouse-custody-http.
- 7 distinct actual Fastify HTTP injection/PostgreSQL cases in cash-capability-postgres.integration.test.ts, selected only by driver work UI HTTP:. Controlled onboarding, existing synthetic accepted pricing/entity prerequisites, normal order creation, normal driver invitation/acceptance and dispatcher assignment. The journey driver has exact local-driver.v1, zero scopes, no broad shipment keys and no cash supplement; linehaul uses exact linehaul-driver.v1. Actual pickup transitions, multipart PNG proof and identical proof retry, bounded named destinations, pickup offer/retry/conflict, staff intake, nominated linehaul accept/retry, separate destination receive, exact local last-mile accept, confirmed delivery proof/delivery/retries and revocation. Foreign/unrelated/wrong-type, anonymous, cash and generic bulk mutations deny with unchanged business graphs. One owned planned internal leg is a synthetic route prerequisite, not restored route planning.
- Existing 122 committed migrations applied only to each new empty disposable instance for test setup; no new migration or repeat migration-certification claim.
- Runs cp-verification-87c844c3c4e9 (fixture compile error; zero cases), cp-verification-8bf6e05e176a (integration failures) and cp-verification-953511c2ae88 (final seven pass) each verified exact identity/label/tmpfs and removal, with no owned volume/bind storage remaining. No blocked cleanup directory was touched.

Commands: node --test tests/my-work.test.cjs tests/proof-intent.test.cjs tests/membership-session.test.cjs (affected suites; later only new work cases rerun); node --max-old-space-size=6144 node_modules/jest/bin/jest.js --runInBand with the four named focused suites; owned disposable harness with --testNamePattern='driver work UI HTTP:'. Initial backend default-heap type checking exhausted memory; final checks use the established 6144 MB heap. Final backend no-emit (6144 MB), driver no-emit and focused driver ESLint all passed (zero lint errors/warnings).

## Reused evidence and limits

Unchanged backend custody concurrency/order locks, receipts, rollback, financial/cash deadlines and existing HTTP/socket revocation evidence reused. No new real Socket.IO transport, Redis, S3, phone/map provider, native camera, native SecureStore/filesystem restart, device rendering or accessibility execution is claimed. Storage is mocked in the real PostgreSQL proof journey; HTTP is actual Fastify injection, not a running mobile network/transport test. Visual/device verification remains pending; no screenshots were generated or blocked browser channel retried. New My work labels are English; full localization remains follow-up.

Revocation is freshly checked at reads and mutations, and confirmed retries reauthorize. This does not eliminate concurrent timing windows or prove instantaneous UI removal; stale hints never authorize mutation. Accepted linehaul waits for destination staff. No new returns, exceptions, cancellation, suspended-driver action recovery, cash action UI, accounting or FX.

## Rollout and next finite work

Publish additive backend reads before releasing this native app. Missing/incompatible backend reads fail closed. Review the existing five native session/cash/proof prerequisite commits as part of its outgoing range. No configured driver repository deployment workflow exists in source; backend review branch is previously confirmed review-only. Publication does not execute migrations or release an app.

Next: native/emulator acceptance of selected login, camera PNG/signature capture, SecureStore/file survival through restart, scanner, accessibility/font scaling and explicit retry against an exclusively owned local environment. Receipt-less pickup uncertainty needs a separately bounded reconciliation/retry contract before claiming recoverable offline pickup. Native Service Cash requires its own separately authorized integration. Stop this batch; preserve web frontend, manual demo/data, dist and all blocked cleanup.
