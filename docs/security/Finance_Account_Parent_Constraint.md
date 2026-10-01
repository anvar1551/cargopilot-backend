# Finance account parent ownership expansion

Baseline: ebde44f (account-read checkpoint). Bounded plan: retain read containment, add a compound identity target and optional parent relation in Prisma, author a new additive SQL migration, and verify matching insert/update rejection in a new owned PostgreSQL instance. No ownership inference, historical assessor/backfill, accounting policy, data rewrite or account mutation cutover.

## Source/migration correspondence

FinanceAccount gains ownedParent/ownedChildren via FinanceAccountOwnedHierarchy, fields [legalEntityId,parentId] to [legalEntityId,id], restrictive update/delete, mapped FinanceAccount_owned_parent_fkey. The compound unique target is FinanceAccount_entity_identity_key. The authored migration 20261001180000_finance_account_parent_ownership creates that exact unique index and FK. Existing single-parent relation/constraint remains intentionally retained. SQL uses NOT VALID for additive compatibility rather than failing deployment on uncertified existing references. Manual source review compares these targets/actions; offline Prisma validation checks syntax/relations, not full migration equivalence.

## Current enforcement and limits

A non-null parent reference must share the account legalEntityId, for new inserts and relevant reference/key updates. A null parent remains a valid root. Account legalEntityId is already required; no new default tenant is assigned. Existing rows are not rewritten/certified. NOT VALID does not mean that every unrelated-column update rechecks an unchanged historical reference. Explicit VALIDATE CONSTRAINT and any required reconciliation remain separate approved deployment work.

Legal-entity equality does not prove classification as a legal entity, active state, selected company permission, non-null tenant ownership or acyclic hierarchy. Existing legal-entity tenant-null gaps and other finance constraints remain. HTTP/application authorization and scoped parent reads stay mandatory. No generic worker bypass or account/chart authorization changes. Constraint-only rollback must retain application containment; never restore unscoped access. No new-client relation is queried, so application-client generation is not needed for these tests; deployment artifacts must be generated/reviewed separately without overwriting preserved dist.

## Validation

Offline command: node node_modules/prisma/build/index.js validate --config "$env:TEMP/cp-cash-prisma.config.ts" (absolute schema-only config, no dotenv/database URL): passed. No live/shadow database used. Final node node_modules/typescript/bin/tsc --noEmit passed. An initial SQL test string quoting syntax error was corrected before database execution; assertions were not weakened. Existing mocked read/HTTP results reused because their exercised application source is unchanged.

The PostgreSQL suite strengthens the earlier foreign-parent probe into rejection assertions and retains positive selected-context/pagination/legacy-null reads. Exact PostgreSQL error code 23503 and named compound FK are required for foreign insert/update and child legal-entity changes; rejected rows are compared in full. Catalog definitions check compound columns/actions and unvalidated status. This is focused relational evidence, not full schema equivalence or finance posting concurrency.

All prior release blockers remain open, including independent configuration approval, approved exact pricing/FX acceptance and contained invoice issuance/execution, broad finance/journal/period/payment ownership, nullable cutover, hierarchy cycles, RLS and deployed infrastructure validation. No production readiness claim.

Executed node "$env:TEMP/cp-finance-parent-disposable-run.cjs": all 73 migrations applied, tests/security/finance-account-postgres.integration.test.ts passed seven cases (four new constraint assertions/scenarios and three affected read/pagination cases rerun; do not add repeated cases to distinct totals). Exact named 23503 failures were observed for same-tenant foreign-entity and foreign-tenant parent INSERT/UPDATE, and child legalEntityId mutation with retained parent. Full rows stayed unchanged after rejection; valid parent/list/pagination still worked. PostgreSQL catalog matched the compound target/actions and confirmed convalidated=false. This does not certify pre-existing deployed rows or all concurrent posting schedules.

Owned run 0509b0bbfca5 used only the reused runner's cached PostgreSQL 16 Alpine (--pull never), allowlisted environment, synthetic credentials, loopback random port, 512 MiB memory, one CPU, 128 PIDs and 256 MiB exclusive tmpfs. Run-marker/URL guards and bounded connections/statements/deadline retained. Exact container identity/run label/storage were verified before removal. No existing database or shadow database, dist, dependency or generated client changed. Pre-existing identifier truncation notices remain unchanged.
