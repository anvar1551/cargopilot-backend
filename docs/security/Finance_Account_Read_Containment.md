# Finance account-list ownership containment

Baseline: 3ad153a (legal-entity checkpoint). Plan: fresh selected context at service/repository, explicit company scope and finance.accounts.read, active owned legal-entity predicates, scoped code/id pagination and parent queries. No accounting/chart mutations or policy changes.

## Enforced boundaries

GET /api/finance/accounts and listAccounts require AppUser instead of companyId. All source callers were traced and updated; no worker uses this read method. Rows and cursor positions must belong to an active legal entity in the selected active tenant/company. Missing context, permission or explicit company scope deny; legacy null ownership is hidden. Direct repository pagination is bounded to integer 1..100. Cursor lookups are scoped before code/id keyset positioning; a foreign cursor rejects rather than influencing an owned page. No unscoped Prisma cursor remains.

The account DTO matches inspected frontend lib/finance.ts fields: no metadata or broad database record. Parent IDs are collected from at most 101 owned rows; one separate scoped parent lookup retrieves only active selected ownership. Foreign parent IDs/names are not exposed; missing/conflicting parent becomes parentId/parent null. No N+1 query or global parent lookup. PageInfo shape/order/UUID cursor contract preserved; concurrent account edits can affect pagination, not a consistent reporting snapshot.

The shared finance HTTP unknown-error branch previously exposed internal exception text; it now uses the endpoint fallback for status >=500, with a canary regression. Controlled FinanceError/validation formats remain unchanged. No frontend/driver edits or browser/transport verification. Read projections preserve the actual frontend DTO; raw metadata and actor IDs are intentionally omitted.

## Validation

node node_modules/jest/bin/jest.js --runInBand tests/security/finance-account-read-containment.test.ts tests/security/legal-entity-containment.test.ts: 38 passed (16 new account mocked/HTTP, 22 affected legal-entity). Initial compilation found the missing financeBadRequest import; corrected and reran these suites. Final node node_modules/typescript/bin/tsc --noEmit passed after the correction including the new PostgreSQL test. No invoice/cash/session suites repeated.

node "$env:TEMP/cp-finance-account-disposable-run.cjs": full 72 committed migrations, four distinct PostgreSQL cases passed using actual repository/context loading. Tested same user across two tenants/two same-tenant companies, foreign parent suppression, valid parent and owned pagination/foreign cursor rejection with unchanged account rows, and hidden null-owned legal entity. PostgreSQL explicitly accepted the synthetic foreign-parent assignment under the current single-column FK; this is a deferred integrity gap, not successful relational enforcement. No new database constraint or account-write behavior introduced in this checkpoint.

Run 35871f7787a5 reused the owned-resource runner: cached PostgreSQL 16 Alpine (--pull never), allowlisted environment/run-marker guards, synthetic credentials, loopback random port, 512 MiB memory, one CPU, 128 PIDs, 256 MiB exclusive tmpfs, bounded connections/statements/deadline. Cleanup verified exact identity/run label/storage before removal. Existing containers/services/dist/dependencies untouched.

## Remaining gaps and next step

Add a compound legalEntityId/parentId relationship constraint in a new additive migration; preserve current read containment even when legacy rows have not been certified. Existing FinanceAccount hierarchy FK permits cross-legal-entity parents. Parent equality is not tenant certification of null-owned legal entities. General chart/account mutations, journal/period/payment/source policies, maker-checker configuration acceptance, approved exact pricing/FX, nullable cutover, RLS, concurrency outside these reads and prior release blockers remain open. Rollback must retain scoping or disable reads. No complete isolation/production readiness claim.
