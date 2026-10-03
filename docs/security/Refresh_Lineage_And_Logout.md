# Refresh replacement lineage and successor logout

Verified baseline5c40ba6: atomic single-use consumption and exact selected context exist. UserRefreshSession.replacedBySessionId exists but is never published; logout therefore cannot follow a committed successor. Exact-token logout already verifies purpose/hash/context. These are distinct protections; do not recreate them or infer earlier chains.

Plan before implementation: reuse the replacement pointer with server-owned rotationDepth (root0) and nullable replacementDepth bridge. Add one new additive migration/Prisma compound target+FK for same user/tenant/both memberships and successor depth. Published pointers are immutable, require revoked predecessor and depth+1, cannot self-link/merge or form cycles, and stay retained. New/changed populated references enforced using NOT VALID ownership/completeness constraints; historical certification unresolved. No history backfill or link inference. A unique predecessor index may stop migration if historical duplicates exist; do not repair records silently. Legacy unlinked bound sessions can begin a new tracked segment at depth0; earlier unrecorded successors cannot be retroactively certified. Legacy unbound refresh remains rejected.

Use a selected-context advisory transaction lock for rotation and logout, derived from verified server records; lock/statement/transaction deadlines2s/5s/10s, ReadCommitted. Rotate by current conditional consume, create successor and publish pointer in one transaction; failures roll back all three. Logout verifies exact root possession, waits for the same context lock, reloads/row-locks the exact root and each same-context linked successor, validates the complete chain before conditional revocation, and retains pointers. Separate login roots/other contexts are not revoked. Depth0..256 bounds work to257nodes; rotation at256 requires fresh login. Corrupt/missing/overlong chains fail without partial mutation or a success acknowledgement. No credentials in diagnostics. No generic worker/human override.

Reuse rejection remains non-mutating: replay cannot issue/fork tokens. Automatic family-wide revocation on a duplicate is not added because benign concurrent refresh/retry and compromise-response policy have not been distinguished; family reuse response and distributed access/cache/socket revocation remain separate open work. This slice revokes recorded successor refresh sessions, not already issued access tokens/sockets. Password-change concurrency is adjacent unfinished work.

Compatibility/rollback: login/refresh response and signed claims unchanged; server depth limit may require fresh login. Current clients are deferred, and real browser/device logout behavior is unverified. Deploy additive schema before source; mixed old rotators can omit pointers, so successor guarantee requires all issuers using this version. Rolling rollback must contain rotation/logout or preserve lineage writers/readers; never restore sid-only or untracked rotation. No existing database/service, dependency, client or dist change. Generate ignored Prisma artifacts only for new fields.

Focused acceptance: valid chain/context, matching/replayed rotation, failed pointer publication rollback, foreign tenant/company/user/bridge/depth references on inserts/updates, immutability/merge/cycle/depth bound, old-token and intermediate logout, separate root preservation, malformed chain rollback, concurrent logout before/after prechecked rotation and blocked-lock schedules. Use established guarded disposable runner/full99migration chain, synthetic fixture adapter; PostgreSQL evidence separate from mocks. Run affected rotation/logout/HTTP/session checks and no-emit/offline syntax; no unchanged business audits/suites. Record exact evidence and cleanup below.

## Implemented protection and evidence

The planned pointer publication, compound ownership/depth constraints, deferred
successor acceptance, immutable identity/history and bounded locked logout are
implemented. SQL-only triggers/checks supplement Prisma relations; selected
column/default/compound-target/FK actions were manually compared with the
authored migration, not certified as full semantic schema-to-SQL equivalence.
Both ownership/completeness constraints remain NOT VALID: PostgreSQL protects
new/changed references, but historical records are not certified.

Offline `node node_modules/prisma/build/index.js validate --config
%TEMP%/cp-cash-prisma.config.ts` passed Prisma WASM syntax validation. Required
generation with the same datasource-free configuration wrote ignored
node_modules only. `node node_modules/jest/bin/jest.js --runInBand
--runTestsByPath tests/security/refresh-lineage.test.ts
tests/security/logout-exact-token.test.ts tests/security/tenant-session-auth.test.ts`
passed54 cases:18 new chain boundaries,14 affected exact-logout and22 affected
session/HTTP consumers. Four additional exhausted/invalid-depth cases are
recorded in the backlog. Final no-emit type checking passed.

`node %TEMP%/cp-refresh-lineage-run.cjs` applied all99 migrations and passed16
distinct PostgreSQL cases:8 affected rotation,2 affected exact-binding logout,
6 new lineage cases. Actual application rotation/logout, conditional consumes,
pointer publication and deferred acceptance execute against PostgreSQL. Tests
assert immutable references, cross-user/tenant/company rejection, no merge/orphan,
rollback of successor/pointer and final logout failures, separate roots, stable
reuse rejection, and both logout-before-rotation and observed advisory-lock
waiting on committed rotation. Business record counts and complete session
snapshots are checked. Reruns are not additional cases. Redis is disabled; no
real client/socket/transport/distributed revocation evidence is claimed.

Owned `cp-refresh-lineage-d7080b7b8f27` used cached PostgreSQL16-alpine
`--pull never`, allowlisted environment, synthetic credentials, guarded run
marker, loopback port,512MiB/1CPU/128PIDs/256MiB tmpfs. Exact container name,
run label and exclusively owned tmpfs/no volume-bind storage were verified
before removal; filtered absence and cleanup were verified. No existing service
or data was accessed.

Initial mocked chain/lock cases failed due to tagged-template versus Prisma.sql
mock argument shape; explicit parameterized Prisma.sql was used consistently
and all affected cases reran successfully. Initial type checking caught a
duplicate spread property and passed after correction. Neither failure was
counted as passing evidence or resolved by relaxing a security assertion.
