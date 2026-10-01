# Financial-period read containment

Baseline: e904b60bfe17b82e5cefed30c76f7bcd10c5edad. Plan: fresh selected actor at service/repository; finance.periods.read and explicit stored company scope; active legal-entity ownership; scoped cursor detail and descending date/id keyset; safe projection and strict declared filters. No migration, default ownership or read-driven configuration writes.

## Current enforced behavior

Only GET /api/finance/periods and its direct listPeriods callers exist. No standalone detail endpoint or state/date filter exists; none was invented. List items and cursor detail both require active matching selected tenant/company legal entity. Existing closed/restricted/open periods can be read under the same ownership permission. Null-owned or inactive legal entities hide their periods. Missing context/permission/company scope denies. Cursor records are queried inside the same ownership predicate and projected only to id/startDate; foreign/hidden cursor returns404 before listing. Date/id keyset preserves descending order and pageInfo/UUID cursor contract. Limits are integer1..100 at repository entry; malformed cursor and unsupported direct page fields reject400. HTTP accepts only cursor/limit; unknown ownership/status filters now reject rather than being silently ignored.

Projection matches inspected frontend lib/finance.ts FinanceFiscalPeriod: id, legalEntityId, fiscalYear, periodNumber, name, startDate/endDate, status, closedAt, createdAt/updatedAt. Closure/reopen actor IDs, reopen metadata and nested entity data are omitted. AccountingSetupWorkspace and FinanceOverviewWorkspace use only supported pagination. Internal listPeriods now takes AppUser, not companyId. Other period lookups inspected belong to financial mutation/posting workflows and are not described as protected tenant-facing read APIs by this slice. No client/device or real transport verification.

## Reproduced helper dependency and correction

First actual PostgreSQL run passed five cases but failed the stored-scope-removal assertion: access-control.ts supplies a default company scope when membership.scopes is empty. Earlier finance helper checks of snapshot.scopes therefore did NOT prove explicit stored scope in that case. The finance-specific requireLegalEntityContext now additionally queries MembershipScope by verified companyMembershipId, company scope type and verified selected company; absent grant rejects403 FINANCE_COMPANY_SCOPE_REQUIRED. No global access snapshot policy was changed. This also strengthens legal-entity/account reads and the pre-containment configuration checks. Existing identity/order uses of synthesized scope remain an adjacent recorded dependency, not certified by this correction.

Fresh membership/permission checks and stored scope are required for each call; changes after the final read can still race with a response. No immediate/distributed revocation guarantee. Reads never call transactions or mutate periods, legal entities, audit/business outbox/configuration; authorization caching is not a business mutation. Current invoice/configuration write containment and NOT VALID historical constraints remain unchanged.

## Validation

Initial node node_modules/jest/bin/jest.js --runInBand tests/security/finance-period-read-containment.test.ts:31 new mocked/HTTP cases passed before discovering the snapshot fallback in PostgreSQL. After the helper correction, node node_modules/jest/bin/jest.js --runInBand tests/security/finance-period-read-containment.test.ts tests/security/finance-account-read-containment.test.ts tests/security/legal-entity-containment.test.ts:70 passed (32 period including the new stored-scope regression,16 affected account,22 affected entity). Those reruns are not new distinct cases. Final node node_modules/typescript/bin/tsc --noEmit passed after the helper/test correction. Unchanged cash/invoice/session suites and schema validation not repeated.

The reused owned runner targets tests/security/finance-period-postgres.integration.test.ts, actual repository/fresh context loading, Redis disabled. First run aab1aeba94f8 applied all73 migrations and yielded5passed/1failed; assertion retained and implementation corrected. Cleanup verified the owned instance/storage before removal. The rerun uses a new unique instance and reruns all six because the positive stored-scope query is newly exercised by every read, rather than reusing five cases whose helper source changed.

## Visible blocked flows and limits

- New invoice issuance/execution: approved exact pricing acceptance and FX policy missing; still contained.
- Legal-entity configuration: independent durable approval missing; still contained.
- Period creation/close/reopen: current single-actor workflow/ownership gaps remain separate, not certified by reads. Architecture12 requires separate actors for close/reopen/sensitive configuration.
- Historical NOT VALID parent constraint, tenant-null cutover, broader finance/posting concurrency, generic default scopes, distributed revocation/Redis lifecycle, provider recovery and prior release gates remain open.

Rollback must retain scoping or disable the read path. No complete isolation/production readiness claim.

Final node "$env:TEMP/cp-finance-period-disposable-run.cjs" rerun4c0c8279ecea applied73 migrations and passed all six distinct PostgreSQL cases in one run; do not add the earlier five passes as additional cases. Actual source predicates/cursors/projections, two tenants/three companies, null/inactive ownership, current membership revocation and loss of stored scope all exercised without period/entity/audit/outbox changes. Runner preserved cached image --pull never, allowlisted environment, synthetic credentials, loopback port, run-marker/URL guards,512MiB memory,oneCPU,128PIDs,256MiB owned tmpfs and bounded connections/statements/test deadline. Identity/storage-verified cleanup removed both owned runs. No existing databases/services, dependencies, client generation or dist touched; pre-existing migration identifier notices unchanged.
