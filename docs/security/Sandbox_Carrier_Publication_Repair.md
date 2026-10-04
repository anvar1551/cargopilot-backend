# Bounded sandbox carrier publication repair

Baseline: 14f65bb1ba8b9b8af22b5fc7a83692206987c5f4. The dispatcher commits its delivery result separately from canonical enqueue. A crash between those commits can leave accepted successful work without a canonical event. This slice repairs only that missing publication, not provider execution or uncertain outcomes.

## Current enforced mechanism and unavailable public workflow

repairSandboxPublicationInternal accepts an authenticated selected context and the original outbox UUID only. It is not routed, exported through the public application API, scheduled or called by a worker. Existing retry-now/replay endpoints still reject with INTEGRATION_OUTBOX_RECOVERY_REQUIRED. The integration.outbox.replay registry permission describes replay/retry but the current recovery guard requires additional reconciliation authority. It must not silently become public repair approval.

The internal entrypoint requires fresh integration.outbox.replay and shipment.bookCarrier permissions, an explicit selected-company scope, eligible tenant/company memberships and the existing parent-order authorization. It rechecks memberships inside the transaction and applies the membership-only object predicate to the actual owned parent lookup. User-global links cannot replace that predicate. Missing/foreign context and inactive ownership deny. Authorization retains the existing last-read timing boundary; no instantaneous concurrent revocation guarantee.

Decision required before public activation: which company-scoped actors may repair publication of an already accepted successful sandbox operation, and does the existing replay permission plus booking permission suffice or require independently recorded reconciliation acceptance? No eligibility, checker or delegation policy is invented. This decision is separate from accounting and provider cancellation/reacceptance. Until resolved, the mechanism is internally tested but the user-facing recovery workflow is unavailable.

## Durable authority and transactions

Reload loadAcceptedCarrierOperation and its authoritative tenant/company/order/provider/leg graph. Only fake_carrier, sandbox, create_shipment, sent, one admitted attempt and a matching durably successful HTTP 2xx delivery result qualify. Response must contain the existing normalized partnerShipmentId; time ordering, bounded content and any existing booking reference must agree. No UI/Redis-supplied result, new booking, provider call, lease reset, acceptance reset or fabricated success. Pending, failed, uncertain, unaccepted, unsupported, suspended, malformed and conflicting work remains contained.

Normal outbound enqueue and repair share an advisory transaction lock keyed by the original outbox identity. Existing source derivation and canonical unique targets remain authoritative. Matching canonical content returns its original event; conflict rejects without overwriting. Source and attempt shared row locks protect the result while deriving publication. Receipt identity is outboxId, never a replacement operation ID.

CarrierPublicationRepair stores only original source/attempt/provider/company/tenant references, initiating user and selected membership references, a normalized result digest and server receipt time. Five compound foreign keys preserve source/publication/attempt and user/tenant/company bridge consistency. Its purpose check restricts the sandbox capability; an UPDATE/DELETE trigger makes repair evidence append-only. The canonical row and evidence commit together. PostgreSQL constraints do not independently approve success or permission: current application validation remains mandatory.

No business transition happens in the repair transaction. The existing canonical consumer still reloads durable ownership, verifies its lease, applies the supported booking transition and commits tracking plus processed state atomically. Already processed events are not reset. Publication success is not application completion, transport certification or exactly-once external delivery.

Failure before commit rolls back publication and evidence without changing the accepted result. An uncertain commit is retried with the same outboxId and fresh authorization; it returns the existing validated publication/evidence. Later consumer failures remain separate. Source/result changes after publication conflict on retry; no deletion, overwrite or automatic provider replay repairs inconsistency.

Bounds: internal transaction admission maxWait 2 seconds, transaction deadline 10 seconds, statement timeout 5 seconds and lock timeout 2 seconds. Existing publisher retains 2-second admission/5-second transaction and 1-second lock/3-second statement bounds. Lock expiry is transaction completion, not a queue lease. Hash collisions can serialize unrelated sources but cannot merge identities. Bounded contention can fail and be retried by the same source; no immediate retry loop. JSON fingerprint input is limited to 1 MiB and nesting depth 32. No credentials/payloads are returned or logged; internal result contains only source/publication IDs, publication status and repair timestamp.

## Compatibility, rollout and rollback

Additive migration 20261004100000_carrier_publication_repair follows all committed migrations; do not modify history or infer ownership for legacy work. Apply it before deploying code that writes repair evidence; regenerate the client from reviewed source. Only ignored local Prisma client generation was used for checking. No dist writes, deployment, provider access, dependency or client changes.

Public API and payload contracts are unchanged. Normal outbound publication now serializes competing publication through the shared source lock; inbound publication remains unchanged. Canonical event names/content and application contracts remain unchanged. Old publishers do not take the new advisory lock, but existing uniqueness still prevents duplicate publication; a losing repair transaction rolls back its evidence and can retry the original identity. Quiescing old publishers before any future public activation avoids that compatibility contention. No fleet rollout was executed.

Preserve additive table/evidence and existing security guards on rollback; disable callers rather than delete accepted evidence or restore replay. New restrictive foreign keys prevent deletion of referenced source, attempt and canonical evidence. This adds no retention period or production cleanup policy; future retention changes require an explicit traceability decision.

## Validation and evidence limits

Focused native evidence and exact resource cleanup are recorded in the current backlog dashboard. Tests use actual Prisma/PostgreSQL repair and normal publication/consumer code, deterministic synthetic owned fixtures, bounded pools/statements and exclusively owned disposable storage. Fetch/HTTP/HTTPS spies reject any provider invocation; PostgreSQL connections are the only permitted network work. Support auto-triage is mocked, not exercised by successful booking. No storage adapter is imported or invoked by the repair path (source review).

Lost acknowledgement is injected after an actual PostgreSQL commit using a wrapper; it is not a real socket/network failure. Rollback is injected by a database trigger at evidence insertion. Concurrency asserts one publication/evidence; consumer duplicate asserts one booking/tracking fact. Catalog checks verify selected constraint counts and tested semantics, not whole-schema equivalence or certification of historical rows.

Prisma offline syntax validation, no-emit checking and affected canonical-source regressions supplement native evidence. Existing inventory, receipt, carrier signature/authentication and unrelated finance/proof evidence is reused only where source remains unchanged. Real providers, distributed recovery, S3, native devices, infrastructure roles and complete tenant isolation remain unverified or outside this slice.
