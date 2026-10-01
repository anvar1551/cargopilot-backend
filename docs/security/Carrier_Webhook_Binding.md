# Bounded inbound carrier binding

Worker checkpoint: `d1b51d1c84996a24348460f67490583e3fcf9c11`.
This inbound slice remains uncommitted for review. No schema or migration changes.

## Current enforced behavior

Ingress preserves the existing raw-body HMAC verifier, configurable signature headers and timestamp/skew contract. It resolves exactly one active configured integration; UUID selection accepts UUID v7, conflicting company hints fail closed, and the stored secret must belong to that integration. Configured company identity controls persisted metadata, not payload ownership claims. This is the existing generic HMAC contract, not evidence of a real carrier's authentication protocol.

Business application is supported only for the repository-demonstrated `fake_carrier` sandbox JSON `carrier.status.updated` contract. Other carrier providers remain contained pending a reviewed provider-specific contract. The persisted verification result and raw-body digest bind the later processor to verified bytes; the worker does not reverify against a potentially rotated secret.

Application reloads the canonical receipt, raw event, normalization, configured integration, exactly one provider-bound booking reference and leg, one durably accepted successful create-shipment operation, its successful delivery attempt, order, tenant and owning company. Active ownership and command capability must agree. Queue ownership fields cannot choose the target. Optional payload ownership, provider, child and booking aliases must agree with these records; ambiguity, missing bindings and conflicting aliases fail closed. No global order/leg/tracking lookup fallback exists.

Canonical receipt and leg row locks serialize duplicate application and lifecycle checks. Shared locks cover the accepted operation, parent order, tenant, company and provider during application. Tracking/leg updates and the processed receipt commit together. A receipt failure rolls back business mutations. Best-effort support-ticket creation starts only after commit; it is not a durable outbox guarantee. No storage or outbound provider request is performed by this inbound path.

Inbound transitions permit booked to departed/in-transit/exception/cancelled; departed to in-transit/arrived/exception; in-transit to arrived/completed/exception; arrived to completed/exception. Same-state events are allowed. Completed, cancelled and exception cannot reopen; unknown statuses and backward transitions are rejected. Planned legs and bookings already marked failed/cancelled remain contained. This conservative policy does not implement cancellation, correction or recovery.

## Compatibility and remaining gaps

HTTP/event names and payload shapes are retained. HTTP 202 means durable ingress acceptance, not successful business application; duplicate ingress acknowledgement likewise does not prove application. The existing split between raw persistence, normalization and canonical enqueue remains: a crash can leave a raw receipt without canonical work, and recovery is still outstanding. Binding failures become failed canonical records under the existing processor; they create no downstream business effects. Security receipts are permitted persistence.

Legacy unaccepted bookings, ambiguous booking histories, conflicting identifiers, unsupported providers and uncertain outbound outcomes remain blocked. This slice does not infer historical ownership or replay outbound requests. Cancellation/reacceptance, general provider recovery, shared-worker scoping, cash, dispatch redesign, import recovery and RLS remain separate work. No complete tenant isolation or production readiness is claimed.

## Evidence

- Worker review corrected pre-commit support-ticket effects; 32 focused mocked worker tests and no-emit type checking passed before the checkpoint. Other unchanged reviewed evidence was reused.
- `node node_modules/jest/bin/jest.js --runInBand tests/security/carrier-webhook-binding.test.ts`: 23 passing focused tests, including real offline HMAC verification with mocked persistence/network and an arrival-regression rejection. These tests do not prove real carrier transport behavior.
- The unchanged webhook metadata suite's 9 passing tests were retained from this slice's earlier run.
- `node node_modules/typescript/bin/tsc --noEmit`: passed on the final source.
- Disposable PostgreSQL: all 69 committed migrations applied; `order-worker-postgres.integration.test.ts --testNamePattern=inbound` passed 4 tests (5 unchanged worker tests intentionally skipped). Evidence covers concurrent duplicate application, foreign tenant/company/child rejection, receipt-failure rollback with no support effect, and terminal-regression rejection. Synthetic verification receipts in these database tests do not prove provider authentication; offline HMAC tests cover that boundary separately.
- Final database run used only newly owned container `cp-worker-9d06ef1bd544`, loopback binding and disposable tmpfs. Cleanup verified ownership and removed the container and tmpfs; no existing resources or volumes were modified. No live provider, AWS or Redis validation was performed.

No client changes, dependency changes, migration execution on existing databases, staging or push occurred for this inbound slice.
