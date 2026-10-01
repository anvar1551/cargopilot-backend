# Direct order proof, label and transport-leg containment

Checkpoint: core order scoping commit 626d4d0f46ecf594fdff27f88ee3074d1f4e2f96.

## Current enforced behavior

The service-level parent guard requires a complete selected tenant/company membership, uses the established fresh buildOrderScopeWhere policy with the operation permission, and rejects null-tenant or inaccessible orders. Tenant ownership is combined with existing company/object scope; it does not grant every company in the tenant access.

Proof reads and uploads authorize before attachment reads, signed URLs, image processing or storage writes. Uploads additionally retain selected-owner-company and assigned-driver checks. PNG-only decode/re-encode, bounded image workers, server receipt timestamps and separately labelled client capture time remain enforced. Proof signing checks the attachment's orderId and its storage path's order/company against the authorized parent. Legacy order-path proof keys remain readable only through an attachment belonging to an authorized parent. Proof reads use a focused projection instead of loading unrelated cash, invoice and user relations.

Label downloads authorize before reading label content or signing. Parcel labels must belong to the authorized order. Generation, enqueueing, fallback admission and execution require the originating selected membership and shipment.create; creation/import callers propagate it. Delayed fallback rechecks current membership eligibility when it runs. Parcel label updates include orderId. Download response shapes remain { url } or { url, urls }.

Leg list/upsert, document and pricing-component reads/mutations, automatic carrier routing, and booking/track/cancel services guard the parent internally. Requested leg IDs are queried with orderId before writes or outbox creation. Warehouse references require explicit warehouse scope and matching tenant. Carrier commands retain active selected-company provider checks and existing financial restrictions. Automatic carrier booking now requires shipment.bookCarrier; shipment.create alone does not confer it. Pricing calculations were not rewritten.

## Worker containment and compatibility

The order-label worker has no persisted selected membership in OrderLabelJob. runOrderLabelQueueTick returns a 503 containment error before claiming or reading jobs. Existing/new authorized queue rows remain persisted; queue-only configurations cannot complete labels until durable authorization is implemented. Authorized synchronous generation and membership-bound automatic fallback continue to operate. No legacy job is attributed to a membership by inference.

The canonical carrier processor likewise receives no durable selected membership authorization for order/leg mutations. applyCarrierIntegrationEvent now returns a 503 containment error for carrier events before any business lookup/write. The existing canonical processor records failure rather than marking the event processed or ignored. Thus booking requests can be authorized and queued, but carrier completion/status application is blocked pending durable worker authorization and explicit recovery. This slice does not claim provider recovery or automatic replay is safe. Neither worker has a user-global or system-context fallback.

Frontend callers inspected: cargopilot-frontend/lib/orders.ts and lib/documents.ts use the covered proof, leg, carrier-command and label URL endpoints. Driver caller inspected: cargopilot-driver/lib/orders.ts uploads to the proofs endpoint; offline queued items are not given a context bypass. Existing response/event names remain intact. PNG-only compatibility and offline identity binding remain previously documented client release gates; no client files were changed.

## Remaining boundaries

Cash transitions, dispatch lifecycle/concurrency, import partial-success recovery/idempotency, finance resolver access, broad integration outbox authorization, other workers, RLS and nullable ownership migration remain open. Existing rows are not certified by this application slice. Signature URL expiry and membership changes occurring after authorization remain timing boundaries: an already-issued URL is not immediately revoked, and no atomic revocation guarantee across storage/provider effects is claimed. Storage/provider testing is mocked; AWS policy, real storage, real transport, PostgreSQL concurrency and infrastructure isolation are unverified here.

Rollback must retain these guards or disable affected operations. Restoring context-free entry points is not an acceptable rollback.

## Validation

Focused Jest tests cover authorized proof/label/leg flows, selected-tenant and company/object denial, null ownership, missing context/permission, foreign child IDs, no signing/storage/job/outbox effects on rejection and blocked context-free workers. Existing raster tests exercise installed PNG processing with mocked storage. No database schema changed; no migration or disposable database was needed. Final command/results are recorded in the task handoff.

Recorded focused results: order-child-access.test.ts: 16 passed; proof-upload-boundary.test.ts: 24 passed; order-creation-authority.test.ts: 37 passed on the final unchanged creation/import call chain. Commands used the installed Jest binary with --runInBand. The original 46-test checkpoint evidence was reused for the checkpoint commit. Whitespace checks and a credential-pattern scan of the intended source/test/documentation scope passed (zero detected patterns).
