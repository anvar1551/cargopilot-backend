# B2 import receipt visibility correction (2026-10-07)

Baseline: backend 0275cceec8c1b39d18c1c3d3835371e0a9477ad1; frontend
83351c85c3fbe027f8320d0ec013d8cb6f754369. This finite correction preserves
creation transactions, immutable receipts and all financial containment.

## Bounded plan and current enforced contract

Add only a read of existing accepted intents/row receipts; no schema, migration,
receipt mutation, job/replay framework or new permission. Restore the client fields
supported by the existing nested creation DTO without accepting financial authority.

GET /api/orders/import/:operationId/status requires current HTTP session and fresh
shipment.create/company creation scope. The header must match its original user,
tenant, company, tenant membership and company membership and kind=import.
Missing/foreign contexts return404 without revealing whether another intent exists.
Confirmed orders must retain matching tenant/company/creator, and current customer/
address access is rechecked. Existing create/retry authorization is reused; this
endpoint grants no general order visibility. Revoked eligibility fails closed.

The RepeatableRead transaction explicitly sets READ ONLY and a3-second statement
limit (10-second transaction,2-second admission). Maximum100 accepted items,
101-receipt overflow probe; minimal rows expose ordinal, pending/committed,
confirmedAt and order id/number. Response includes operationId, acceptedAt,
rowCount, complete and downstreamCompletion=not_assessed; Cache-Control:no-store.
Ordinal is zero-based data-item position, not necessarily a physical CSV line.
No receipt for a slot means pending in this snapshot, not external failure.
404 is not permission to abandon: acceptance may still be in flight. A status read
cannot accept an intent, create/reprice an order, claim a job or call a provider.
Fresh checks describe this read's authorization snapshot, not absolute concurrent
revocation guarantees. Unsupported/inconsistent evidence rejects.

Accepted identity mismatch now returns409 plus code
ORDER_CREATION_IDENTITY_CONFLICT through the existing sanitized error projection.
Other operational409 responses receive no such code. The client reserves conflict
state for this explicit code; legacy unclassified409 records become uncertain
while retaining original content/context/UUID. No automatic POST or intent deletion.
Frontend uses a15-second read deadline and epoch/context suppression.

Per-row atomicity and partial-success semantics are unchanged. Explicit full-batch
retry reauthorizes, returns existing rows and creates missing rows under the existing
durable serialization. It does not repeat completed-row label/carrier/pricing work.
Labels/providers/components can need separate reconciliation even when all receipts
are committed. Deploy this additive backend read/code before the corrected client;
older servers leave status unavailable and retain the original intent safely.

## Executed versus reused evidence

- node node_modules/jest/bin/jest.js --runInBand
  tests/security/import-receipt-status.test.ts
  tests/security/order-creation-http.test.ts
  tests/security/order-creation-intent.test.ts:28 distinct passing cases.
  Final formatting-only status suite rerun:12/12, included in28, not new cases.
  Fresh scope, foreign/inconsistent ownership, master denial, bounds/UUID,
  read-only transaction/projection and explicit-versus-operational409 covered.
  These are mocked unit/HTTP evidence, not PostgreSQL concurrency evidence.
- node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit
  --incremental false:final EXIT0. No client generation or schema change.
- Disposable run f5dca47d5796:122 unchanged migrations applied to new empty
  PostgreSQL16. Existing bounded harness reused, cached image/no pull,
  loopback-only random port,1CPU/512MiB/128PIDs,256MiB owned tmpfs, no bind/volume.
  Controlled synthetic onboarding separately provisions two tenant administrators;
  actual login, customer creation, order/import routes and transactions exercised.
- One browser journey: scoped customer -> restored normal order -> identical retry;
  two-row preview -> first order/receipt commits -> test-only label enqueue boundary
  throws operational409 -> reload -> authoritative first ID and pending second item
  -> explicit original full-batch retry. Resumption retains first ID and adds one
  order/receipt only:final3 orders,3 receipts,2 intents. Both HTTP retry bodies/IDs
  were byte-content equivalent in captured JSON. Dates are the browser Europe/Berlin
  instants explicitly converted to UTC; PostgreSQL persisted schedules, coordinates,
  parcel weight/dimensions, flags and references match. Route country/city/mode also
  reach the existing creation DTO and normalized client intent; this does not claim
  a newly persisted route model or an accepted financial price.
- Eight distinct actual HTTP/PostgreSQL assertions: partial minimal read/no-store and
  no business-count changes; foreign404; anonymous401; malformed UUID400;
  changed-content typed409/no writes; exact retry bodies/IDs; restored field read-back;
  final no-duplicate counts/first ID. Executed existing external harness commands:
  node %TEMP%/cp-b2-correction-disposable.cjs;
  node %TEMP%/cp-b2-correction-partial.cjs;
  node %TEMP%/cp-b2-correction-final.cjs. Initial assertion-helper table-name errors
  were corrected; they produced no successful evidence and are not extra cases.
- External label/storage, carrier booking, pricing-component seeding, support effects
  and Redis invalidation mocked. Failure injection is after a real committed row at
  the mocked label boundary; no real provider outage/recovery claim.
- Existing creation/import concurrent deduplication/rollback and notification evidence
  reused because those transactions, schema, dependencies and runtime configuration
  are unchanged. No broad suite or new concurrency guarantee claimed.

API/database host stopped; container label/name/storage ownership verified before
removal; owned container absent and tmpfs removed. No listeners remain on3218/4318.
Automatic approval review rejected cleanup of the new frontend source copy at
C:/Users/Anvar/AppData/Local/Temp/cp-b2-correction-7EbPJG as blocked by policy.
Leave its isolated output/dependency junction for manual cleanup; no retry/bypass.
All prior blocked directories and backend dist remain untouched.

Tooling incident: invoking python unexpectedly triggered the Windows runtime manager
and installed Python3.14.8 before interruption completed. No project dependency files
changed; subsequent edits/checks used installed Node. No further runtime changes made.

B2 correction complete; B3 and driver work not started. Merchant COD, financial
adjustments/accounting/FX, uncertain downstream replay, real storage/providers/device
and all existing production release gates remain unavailable/unverified as documented.
