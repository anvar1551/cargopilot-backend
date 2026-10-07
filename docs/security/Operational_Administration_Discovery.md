# Operational administration discovery — bounded plan

Baselines: backend ea985c879d7a7290df79cc29a3941830102ec9cd;
frontend fc7b3590ffd581ea27e0087e8d0551255411dd38.

1. Add GET company-invitations (own original-inviter metadata/status), GET
   company-operational-delegation (accepted revision/profiles), GET
   company-operational-delegation/warehouses (owned ceiling resources), and GET
   company-operational-grants (current manageable grants). Reuse the transaction's
   existing member/authority/ceiling/managed-scope checks. No new permissions.
2. All reads require fresh selected context and accepted authority. Invitation
   visibility follows cancellation's original-inviter rule. Managed grants exclude
   self/delegators, foreign bridges, unrelated roles/scopes and existing active
   grants outside the actor's ceiling. Return explicit metadata only, bounded
   cursor pages, no-store. Read transactions may lock authority but perform no writes.
3. Replace manual staff selectors with authoritative invitation, warehouse and
   managed-grant discovery. Preserve immutable intents, original retries and token
   handling. Current discovery never modifies a pending intent. Mutation revalidation
   remains mandatory; stale snapshots grant no authority.
4. Focused read/filter/projection/no-write tests; one new owned PostgreSQL/browser
   journey with synthetic ceiling/warehouses/admins and real routes. Reuse unchanged
   mutation/concurrency/socket evidence. No schema change, backend-first additive
   rollout; absent/expired/revoked authority disables discovery/actions.
5. Review explicit paths, whitespace and secret checks; local backend and frontend
   checkpoints. Update coverage/evidence and stop. Driver work remains unstarted.

No real invitations, signing in browser, dependencies, existing-service access,
production, push, deployment or blocked-directory cleanup.

## Implemented read contract

The four additive GET routes above are under /api/auth. Inventory queries accept
limit 1–50 (default 20), context/collection-bound cursor and, for invitations only,
optional invitationId. The ceiling response returns the immutable revision, three
approved operational profile revisions and current canInvite flag. Warehouses are
named resources within the accepted owned ceiling; no exclusive company ownership
is inferred. Invitations follow original-inviter cancellation authority. Grants
exclude self, delegators, unrelated roles/scopes and targets outside the current
ceiling. Revoked grants show historical managed scope, not active access.

All responses, including authentication failures, are Cache-Control: no-store.
Transactions reload selected membership and accepted authority using existing
mutation locks. They perform no business/audit/session writes. Returned candidate
pages are bounded; grant filtering can produce an empty page with nextCursor.
Cursor integrity does not grant authority: every query retains server ownership
predicates. Query-plan and production-scale performance remain unverified.

No schema, migration, permission, profile or mutation contract changed. Roll out
backend reads before the frontend selectors. UI snapshots never authorize a later
mutation. Lost invitation secrets are not recoverable from inventory or receipts.

## Executed evidence

- Jest tests/security/operational-discovery.test.ts: 9 distinct passing mocked
  read/authority/projection/cursor/no-write cases (final source).
- node tests/security/operational-discovery-http.cjs, with
  CARGOPILOT_DISCOVERY_RESOURCE_PATH pointing to the owned disposable metadata:
  10 distinct actual HTTP/PostgreSQL cases. Accepted revision, named owned resources,
  invitation status/projection, foreign references, pagination/cursors, manageable
  grants, narrowed/revoked authority, anonymous/bounds/ownership rejection.
  Reads preserve aggregate user/membership/role/scope/grant/invitation/audit/session
  counts and membership authorization versions. Negative authority states are
  explicitly synthetic fixture changes, not new owner-revocation workflow evidence.
- Existing 122 migrations prepared the exclusively owned empty PostgreSQL database;
  no migration was introduced or changed. Unchanged migration/concurrency/socket,
  permit, invitation acceptance and logistics/finance evidence was reused.
- Final no-emit: node --max-old-space-size=8192
  node_modules/typescript/bin/tsc --noEmit: passed. Initial default-heap invocation
  exhausted memory. A subsequent review caught shared-helper projection typing;
  retaining the original helper and adding name only to the grant query resolved it.
- Actual browser against final routes: inventory-selected cancellation, named
  warehouse invitation, inspection/replacement/revocation of a managed scope,
  reload and identical confirmed retry. Four unique browser mutation audit IDs;
  repeated retry did not duplicate. Revoked accepted authority suppresses selectors
  and mutation retries. No tokens/passwords were captured in screenshots.

Storage/provider/Redis boundaries were mocked. No new Socket.IO transport, email,
production, native-device or infrastructure claim is made. Frontend evidence and
responsive screenshots are recorded in its Operational_Administration_Discovery.md.

## Cleanup and remaining boundaries

Owned container cp-verification-ac50b095df68 and tmpfs were removed after exact
label/name/storage verification. Both synthetic API hosts and the frontend listener
stopped. Automatic approval review rejected removal of
C:\Users\Anvar\AppData\Local\Temp\cp-frontend-discovery-owned-MDFV8l as blocked by
policy; leave for manual cleanup without retry/bypass. Prior blocked directories,
Python runtime, dist and unrelated work were preserved.

No secret regeneration, email delivery, unsafe abandonment, driver administration,
financial delegation or owner signing UI. Uncertain mutation recovery retains its
original intent; inventory alone does not certify a local receipt. Next frontend
milestone remains driver invitation/managed eligibility integration after review.
