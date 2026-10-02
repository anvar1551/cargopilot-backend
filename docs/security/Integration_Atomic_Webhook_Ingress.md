# Atomic integration webhook ingress

## Enforced behavior and boundary
Verified gateway ingress now issues opaque in-process evidence only after the configured verifier succeeds. HTTP/queue fields, signatureVerified booleans and copied objects cannot issue that evidence. Repository writer ports accepting raw/normalized caller fields were removed. Trusted server dependency injection is still trusted; this is not a defense against arbitrary process compromise.

Persistence reloads and share-locks provider/company/tenant, verifies active populated ownership and configured tuple, and serializes provider/event identity with a transaction advisory lock. Raw evidence, normalized event and pending canonical event commit together. Normalized ownership derives from the newly inserted raw record, not event-type prefixes or payload ownership. Existing source derivation checks exact JSON/time/context before pending creation. No provider, Redis, storage or other external operation runs in the transaction.

20261003010000 adds two compound unique targets, a normalized/raw context FK and nonnull normalized-company check. FK/check are NOT VALID: new/changed references are protected; historical rows are not certified, inferred or changed. Previous simple raw FK remains intentionally. Optional Prisma relation reflects legacy nullability, not an authorization fallback. Database constraints prove tuple equality, not signature authenticity or business lifecycle authority.

## Retry and compatibility
Accepted202 means the complete durable metadata receipt committed, not carrier/payment processing completion. Matching freshly verified retries return duplicate200 without changing the first occurredAt, including the existing normalizer's receipt-time fallback. Conflicting raw content/ownership is409. Incomplete historical raw/normalized/pending records remain503, untouched and unacknowledged; no overwrite, silent repair or automatic provider replay. Concurrent same-source transactions serialize; database timeouts/failures never acknowledge success. processedAt is no longer set merely for normalization.

Generic HMAC provider authentication remains its existing configured contract. Only existing bound sandbox carrier execution is supported; this does not authorize real providers or finance execution. Client response shapes/event names preserved. Internal persistence port changed to mandatory verified atomic persistence; all located gateway consumers updated. JSON evidence is copied into its storage representation before exact source comparison; no sensitive logging.

Migration must precede changed writer deployment. Rollback retains constraints and last safe source enforcement, or disables ingress; it must not restore permissive/unscoped writes. Historical incomplete receipts need separately authorized reconciliation. No migration applied to an existing service.

## Validation
Initial Prisma WASM validation rejected a required relation using nullable companyId; corrected to optional relation, then offline validation and ignored node_modules-only generation passed. Selected SQL targets/relations and PostgreSQL constraint catalog reviewed; not a claim of complete schema-to-SQL equivalence.

Initial affected five-suite run:104 mocked/offline-HMAC/HTTP cases passed; no-emit passed. Disposable run0aeeb9cb7efc applied89migrations:14passed/3atomic-ingress failures. Exact payload comparison detected clone object representation differing from persisted JSON. Corrected JSON normalization rather than weakening equality/assertions. Focused rerun:8affected mocked/offline-HMAC cases passed (41skipped); native53232940372e at89migrations reran3failed cases, all passed (14skipped).17distinct PostgreSQL cases across these runs, not20. Both owned resources removed and absence verified. Final no-emit result recorded in backlog.

Commands: node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/security/integration-webhook-acceptance.test.ts tests/security/webhook-metadata-boundary.test.ts tests/security/carrier-webhook-binding.test.ts tests/security/integration-canonical-source.test.ts tests/security/integration-provider-http.test.ts; node %TEMP%/cp-cash-schema-check.cjs (allowlisted environment/no-dotenv config/validate+generate); node %TEMP%/cp-integration-source-run.cjs; affected retry node %TEMP%/cp-integration-atomic-run.cjs; node node_modules/typescript/bin/tsc --noEmit.

Each native run uses a new loopback-only labeled cached-image (--pull never) PostgreSQL instance, synthetic credentials,512MiB/1CPU/128pids, exclusively owned256MiB tmpfs, run marker/fullchain, bounded test pools/deadlines and verified identity/label/no-bind/no-volume cleanup. Database evidence covers actual repository transactions, not real provider transport; native verifier normalization is mocked, actual offline HMAC evidence separate.

## Remaining gates
Dedicated generic HMAC callback admission/native pending-work limits remain next. Secret version/pointer serialization, incomplete historical receipt reconciliation, real-provider contracts/recovery, approved finance/accounting/FX/checker policy, broader tenant cutover/RLS and infrastructure/Redis/storage/device certification remain open. No exactly-once external delivery or production readiness claim.
