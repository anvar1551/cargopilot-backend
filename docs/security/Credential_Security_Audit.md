# Credential-change security audit

Confirmed gap after8e66aef: self-service password change is atomic and revokes
durable access authority, but has no durable security event. FinanceAuditEvent
is a finance-specific document model and is not an identity audit destination.

Plan before implementation: add one append-only CredentialSecurityEvent model
for PASSWORD_CHANGED. Required actor/tenant/tenant-membership/company/company-
membership identities, database-generated ID and server receipt time only. Reuse
existing compound CompanyMembership session/owner targets to prove both bridges
agree; no new ownership guesses, historical backfill or generic audit API.
Write the event inside the existing locked credential/revocation transaction.
Failure rolls back credential, sessions and event. No passwords/hashes/tokens/
session identifiers/IP/header/free-form metadata in this table or diagnostics.
No event read endpoint or broad user projection. No event for rejected attempts
in this bounded slice; future bounded sanitized rejection telemetry is separate.

New empty table constraints are validated, unlike prior NOT VALID historical
expansions. UPDATE/DELETE/TRUNCATE prohibited by SQL triggers; parent membership
references RESTRICT rather than cascade, retaining audit ownership/history.
Membership/user erasure and audit retention/pseudonymization require a designed
policy before those contained administrative workflows are restored. No retention
duration, deletion override or family compromise policy is invented.

Deploy additive table before writer; rolling rollback must preserve the audit
writer or contain credential changes, never silently drop the audit. No migration
execution outside newly owned disposable PostgreSQL, no clients/dependencies/dist.
Validation: offline schema syntax/manual selected schema-SQL comparison; affected
password tests and actual accepted event/concurrent change/rollback/foreign
bridges/immutability/catalog cases using existing guarded disposable runner.
Reuse unchanged access/transport evidence; audit changes no read/token contract.

## Executed evidence / 2026-10-03

Offline Prisma WASM syntax validation passed: node node_modules/prisma/build/index.js validate --config %TEMP%/cp-cash-prisma.config.ts (datasource-free config, environment allowlist). Necessary generate with that config wrote ignored node_modules only. Manual selected enum/columns/defaults/compound FK actions/index comparison and native catalog checks are not complete semantic schema-to-SQL equivalence or historical certification.

node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/security/password-session-serialization.test.ts passed17 distinct mocked cases (16affected,1new). Final node node_modules/typescript/bin/tsc --noEmit passed. Existing rotation/access evidence reused only where exercised source remained unchanged.

Guarded %TEMP%/cp-credential-audit-run.cjs applied the full100migration chain and passed11 distinct actual cases:6affected credential serialization cases,3new audit cases,1affected HTTP password-cleanup case and1affected real Socket.IO idle password-revocation case with two independent processes.21unchanged cases intentionally skipped, reruns not summed. Accepted concurrent credential changes produce one audit event; failed audit insert rolls back password, sessions, audit and business state. Foreign actor/tenant/company/both-membership inserts, update/delete/truncate reject with unchanged snapshots; both new compound FKs are validated RESTRICT constraints. Exact event field allowlist and database receipt time verified.

New owned cp-credential-audit-7cb42c801e0c used cached PostgreSQL16-alpine --pull never, synthetic environment/credentials, loopback-only port,512MiB/1CPU/128PIDs/256MiB owned tmpfs. Name/run-label/storage verified before removal; label-filtered absence confirmed, runner exited0. No existing resources, Redis/AWS/providers, clients/dependencies/dist or external transport accessed. Local real websocket evidence is not deployed cluster or device proof. Existing final-read/commit races and load-dependent revocation sweep window remain documented in Durable_Access_Session_Revocation.md.
