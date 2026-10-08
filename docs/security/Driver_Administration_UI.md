# Driver administration UI — implementation and evidence

Baselines: frontend d4986a50c3e512e7cf961d3f8c3e796ff64ddb8c;
backend ba2e7e32cfd1fae7f212a7653a5937b13cdd6835.

1. Add only selected-context no-store GET driver ceiling, original-inviter
   invitation inventory/status and manageable eligibility inventory. Reuse driver
   authority/ceiling and exact eligibility checks; bounded context-bound cursors.
   No scopes, permissions, mutation/schema changes or operational authority fallback.
2. Isolated driver intent storage and typed contracts reuse established persisted
   intent discipline: before-send verification, Web Locks, explicit immutable retry,
   late-context suppression, transient tokens/passwords, authenticated existing-user
   acceptance. Separate driver recipient route and zero-scope selectors.
3. Replace obsolete arbitrary driver-creation/profile mutation controls with the
   controlled workspace; preserve authorized roster/manifest via a separate tab.
4. Focused reads/client/API tests and synthetic disposable PostgreSQL/browser
   provisioning -> acceptance -> selected login -> inspection -> replacement/revoke.
   Verify active-work rejection; reuse unchanged underlying mutation concurrency,
   pickup/proof/custody/socket evidence. Final type/lint, owned-resource cleanup.
5. Review and commit explicit source/tests/docs only, update coverage, stop.

Backend-first additive rollout. Lost tokens cannot regenerate, uncertain intents
cannot be abandoned; absent/revoked accepted authority disables administration.
No driver-app changes, cash, real invitations/keys, dependencies, push/deployment.

## Current enforced contracts

Additive authenticated `GET /api/auth/company-driver-delegation` returns only the
selected actor's currently accepted driver ceiling/profile revisions and invite
eligibility. `GET /api/auth/company-driver-invitations` lists only the original
inviter's selected-company invitations. `GET /api/auth/company-driver-grants`
lists manageable exact driver memberships within that accepted ceiling, including
revoked workflow-managed eligibility. All require fresh selected context and
accepted driver authority, use `Cache-Control: no-store`, and perform no writes.
Ordinary permissions or operational delegation alone cannot establish authority.

Inventory parameters are `limit` (1–50, default 20) and a bounded context-and-
collection-bound cursor. Database candidates are bounded before eligibility
filtering; a page can be empty with a next cursor. Projections omit invitation
tokens/hashes, acceptance fingerprints, credentials and unrelated roles/scopes.
Active-work metadata is advisory; the existing locked mutation revalidates it.
Reads do not acquire eligibility SHARE after the authority lock; existing mutation
lock order and receipts remain unchanged. No schema or migration was added.

Existing POST invitation, cancellation, acceptance and eligibility contracts are
unchanged. The UI uses local-driver.v1 (six existing keys) and linehaul-driver.v1
(three existing keys), exact managed roles and zero scopes. It never changes
User.driverType. Selected company membership, not a shared identity field or role
name, remains eligibility authority. No cash capabilities are exposed.

## Executed evidence (2026-10-08)

- Backend focused Jest discovery regression: 7 distinct cases passed.
- Frontend intent/acceptance tests: 20 distinct cases passed; discovery adapter:
  5 distinct cases passed. The discovery fixture labels were corrected and those
  same five cases rerun; reruns are not additional cases.
- Actual HTTP/Prisma/PostgreSQL: 12 distinct cases passed (nine completed cases
  plus three affected tail cases). They cover accepted independent ceilings,
  invitation retry/conflict, new enrollment/selected login, metadata-only/no-write
  reads, foreign context/mutation, replacement retry, active-work rejection with
  unchanged business/grant/session state, revoke/reinstate, authenticated existing
  identity binding with another-company membership preserved, ordinary-driver
  denial, revoked authority and bounded/context-bound pagination.
- Browser against those actual services: invitation creation/cancellation,
  transient clipboard handoff, new acceptance, fresh selected login, selector-based
  local-to-linehaul replacement, matching replacement retry and revocation.
  Two undelivered test invitations were explicitly cancelled before new actions;
  secrets were neither recovered nor regenerated. Acceptance cleared credentials.
- Desktop (1440×1000) and mobile (390×844) inspected; mobile document width equals
  viewport width. Screenshots are outside repositories. Final backend/frontend
  no-emit TypeScript and focused frontend ESLint passed.

Commands: `node node_modules/jest/bin/jest.js --runInBand
tests/security/driver-administration-discovery.test.ts`; `node --test
tests/driver-administration.test.cjs tests/driver-discovery.test.cjs` (separate
focused invocations); backend `node --max-old-space-size=8192
node_modules/typescript/bin/tsc --noEmit`; frontend `node
node_modules/typescript/bin/tsc --noEmit --incremental false`; ESLint restricted
to the eight authored driver workspace/recipient/adapter/route files.
The guarded `tests/security/driver-administration-http.cjs` ran only against the
new owned loopback host and disposable PostgreSQL, not application startup.

The 122 unchanged migrations prepared the empty disposable database; this is not
new migration/concurrency certification. Active-work test assignment and authority
revocation were explicitly synthetic prerequisite/state fixtures. User mutations,
authentication and query authorization used actual services. Storage/providers,
Redis/cache invalidation and unrelated background boundaries were mocked. Existing
driver mutation concurrency/rollback, pickup/proof/custody and HTTP/socket
revocation evidence is reused unchanged, not claimed as newly executed.

## Compatibility, rollout and remaining boundaries

Deploy additive backend reads before the frontend; unavailable/revoked authority
disables administration. Frontend `/dashboard/manager/drivers` now hosts controlled
administration, `/dashboard/manager/drivers/roster` preserves the authorized fleet
view while removing obsolete arbitrary creation/profile controls, and
`/invitations/driver/accept` is the transient recipient flow. Existing operational
staff UI and mutation contracts remain separate.

The web driver dashboard remains its pre-existing placeholder; no native/device
logistics verification or driver-app implementation was performed. Real email/
private delivery, real operator key registration and real provisioning remain
unperformed. Confirmed receipt metadata is not live authority. Unconfirmed intents
cannot be edited, deleted or blindly replaced; token issuance uncertainty requires
original inviter review, and a lost new-user response requires authenticated
confirmation using its preserved identity. Inventory snapshots never authorize a
mutation, and production-scale query plans remain unverified.

## Cleanup and next bounded task

Owned run 92a60a4c191f: PostgreSQL container cp-verification-92a60a4c191f and its
exclusive tmpfs removed after label/name/storage checks; API cleanup verified.
No listeners remain on test ports 4330/3230. The frontend server stopped; policy
review rejected deletion of cp-frontend-driver-admin-owned-12Zb5x. It remains for
manual cleanup; no retry or bypass was attempted. All earlier blocked directories,
unrelated work, dist and the unexpectedly installed Python runtime were preserved.

Next task after external review: controlled warehouse-provisioning UI using
existing owner-appointed provisioning authority and separate accepted operational
warehouse ceilings. Define that finite milestone before implementation; no owner
signing, automatic warehouse grants, financial/cash UI or native-app changes.

Final test-only review replaced full graph comparison output with SHA-256 graph
snapshots so a failed unchanged-record assertion cannot print credential hashes.
The comparison covers the same records; the logging-only change was syntax-checked
with `node --check tests/security/driver-administration-http.cjs`. The recorded
12 database cases precede this output-minimization adjustment; no additional
database run is claimed. Final UI review also fixes profile selection for a
linehaul-only ceiling and pins revocation to the inspected current profile.
