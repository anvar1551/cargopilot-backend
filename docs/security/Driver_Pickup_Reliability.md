# Driver pickup reliability - 2026-10-11

## Finite plan and baselines

Backend afaa3e8; driver 00acfc9. Confirmed source defects: initial pickup lacked a server receipt; terminal local history exhausted a lifetime 100-record ceiling. Plan: additive context-bound receipt and atomic facts; v2 native unchanged retries with legacy quarantine; verified archival before pruning terminal history; focused PostgreSQL/client checks. No cash/financial policy or broader logistics changes.

## Current enforced contracts

POST `/api/orders/driver-status` requires UUID `operationId` for pickup_in_progress and picked_up at the service boundary too. Existing fields and success/order envelope remain. Pickup order projection adds operationId, orderId and eventId. Normalized v1 content binds order/status, nullable reason/note/region and exact selected user/tenant/company/membership bridge. Missing and null optional values match. Other transition policies are unchanged.

Transaction order: tenant/operation advisory lock; fresh accepted local-driver eligibility SHARE fence; receipt lookup; owned/current-assignment Order UPDATE lock; fresh authorization/workflow/cash checks; conditional transition; Tracking, eligible notification, analytics outbox and immutable receipt. Different operation identities serialize on Order. Confirmed retries require fresh action/eligibility and original current assignment/owning company; they return historical results without repeating business writes or stale realtime status emission. Reassignment/revocation deny original receipts. Status alone never manufactures a receipt.

The receipt is the immutable operation audit: actor bridge, normalized intent/hash, authoritative timestamp, original result and Tracking identity. Compound FKs enforce owning order, company membership/tenant bridge and Tracking parent. UPDATE/DELETE/TRUNCATE reject. No historical backfill/certification or database-owner tamper immunity is claimed.

Native new work records are v2; status body contains original operationId. Confirmation must match operation/order/Tracking and status. v1 status records (including prepared/attempted) remain quarantined; v1 custody receipts retain existing authorization. The unused lib/orders.ts receipt-less adapter has no current screen callers and new backend pickup rejects it.

Active storage keeps 20 terminal records, or 19 plus unresolved work during preparation. Existing unresolved records are never pruned. Terminal records are copied under original context/operation archive keys and exact readback verified BEFORE pruning. A crash may leave duplicate local copies, never discard an unresolved identity. Storage/archive/readback failure blocks sends; failure after a committed response leaves original attempted work for matching receipt retry. Existing records are preserved in active storage or verified archives. No automatic deletion; device space, retention/export and physical SecureStore limits remain unverified.

## Executed evidence

- 9 distinct new actual Fastify-injection/PostgreSQL cases plus 1 restricted-driver setup/discovery regression: missing identity/unrelated/foreign actors; concurrent matching requests and discarded acknowledgement retry; null normalization/content/target conflicts; injected receipt failure and complete graph rollback; competing distinct operations and historical retry; exact sender cash deadline; actual PNG proof codec/submission with mocked storage; append-only protection; reassignment/revoked HTTP/service receipt access.
- Count these 10 cases once across runs. First run: 8 passes, 2 fixture-dependency failures (unrelated driver created by a skipped prior case). Explicit supported invitation prerequisite corrected. Final affected rerun: 4 selected passes; retained 6 unchanged passing cases from first run. No assertions weakened.
- 67 distinct affected mocked cases across dispatch-response-projection, dispatch-selected-authority, dispatch-batch and order-tenant-containment. Updated stale membership-specific eligibility/reference-pin fixtures and new receipt mocks. Final affected reruns pass; counts exclude reruns.
- 27 distinct focused driver cases (5 additional to former 22), including 150 sequential successes, 105 actions through actual adapter with mocked SecureStore, archival failure, restart/context/late-response suppression and immutable pickup retry. Repeated runs are not extra cases.
- Prisma schema validation and required client generation (node_modules only); final backend/driver no-emit checks; focused driver lint. No dependency/build-output changes.
- 123 migrations applied only to new owned PostgreSQL tmpfs resources. Verified labels, names and mount ownership before removing cp-verification-4d3d08b96ba8 and cp-verification-9702a28a4180; both containers/tmpfs removed with no owned volumes/binds. Demo, existing services and blocked cleanup untouched.

## Reused evidence and rollout

Unchanged custody/proof receipt concurrency, cash execution/rollback and Socket.IO/multiprocess revocation evidence is referenced in Driver_My_Work_Integration.md. No new Redis/real socket/mobile-network evidence. Storage mock is not S3; native rendering, physical SecureStore/file persistence and device restart remain unverified.

Apply additive migration and deploy backend before updated driver. Old clients without operationId cannot perform initial pickup; no receipt backfill. No migration on existing services was performed. Legacy uncertain pickup reconciliation, native Service Cash and existing exception/return/recovery limitations remain unavailable. Next finite task: explicitly owned native/device acceptance. Stop after reviewed publication.
