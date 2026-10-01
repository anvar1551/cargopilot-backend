# Fiscal-period mutation containment

Baseline: e0803c21376e4debdbed2aa8261fe712922b12d0. Bounded plan: inspect all period mutation callers; require fresh selected context and existing permissions; contain changes lacking independent durable approval at both service and repository boundaries. Preserve read access and existing posting-period checks. No schema, accounting policy or accepted-operation contract invented.

## Current enforcement and compatibility

POST /api/finance/periods requires finance.periods.manage; PATCH /api/finance/periods/:id/status requires finance.periods.close. Services require the verified active selected tuple and explicit stored company scope before the approval rejection. Missing/inconsistent context or grants rejects403. Eligible requests reject409 FINANCE_PERIOD_APPROVAL_REQUIRED before configuration reads, transaction creation or business effects. Request schemas reject unknown ownership/approval fields. Direct repository commands also reject before transactions; companyId, actorUserId or caller-provided checker/approval markers cannot authorize execution.

Architecture section12 requires separate actors for sensitive configuration and period close/reopen. Existing period records have no independently accepted proposal or durable operation binding. A closedByUserId supplied from the initiating actor does not prove checker separation. The old overlap/draft-journal checks, period transition writes and transactional audit/outbox code remain behind the denial guard; their concurrency and approval safety are not certified. Restoring them requires a separately reviewed durable proposal/acceptance, checker eligibility, workflow/locking and idempotency design. Do not remove containment to preserve legacy behavior.

Inspected direct callers are FinanceService, FinanceRepositoryPort, PrismaFinanceRepository, HTTP routes and the affected service test. Frontend lib/finance.ts and AccountingSetupWorkspace still call these endpoints and display errors; creation and status actions are unavailable until an approved flow exists. No frontend changes or browser evidence. GET /periods remains available. Accepted finance worker posting continues using its existing internal requireOpenPeriod lookup; it does not create/change periods through these methods. This slice neither approves accounting mappings nor certifies worker posting.

Rollback must retain denial or disable these operations. It must not restore single-actor configuration/status mutation. Historical NOT VALID constraints, nullable ownership and current invoice/financial legal-entity configuration containment remain intact.

## Evidence

node node_modules/jest/bin/jest.js --runInBand tests/security/finance-period-write-containment.test.ts tests/finance/finance.service.test.ts:26 passed (23 new mocked/HTTP cases and3 affected service cases). Actual guards/classifier are used with mocked membership/database access. Cases cover fresh context/permissions/scopes, removed stored scope, all status values, forged direct commands, strict authority fields, controlled HTTP responses and continued read access. Every case asserts no transaction or period/entity/journal/audit/outbox mutation. This is mocked no-effect evidence, not PostgreSQL transition/concurrency evidence.

No new database constraints or successful mutation path were introduced, so no additional disposable PostgreSQL run was needed. Six distinct period-read PostgreSQL cases at73 migrations and prior unrelated evidence are reused only for unchanged exercised source. No existing services, migrations, client/dependency changes or generated dist output.

Final no-emit result and checkpoint scope are recorded in the backlog.

## Remaining gates

Independent configuration/period approval and concurrency restoration; approved exact invoice pricing/FX and new issuance/execution; missing approved cash accounting mappings; nullable ownership and historical constraint certification; generic snapshot scope fallback outside finance; distributed revocation/Redis lifecycle; provider/storage recovery; broader finance/repository scoping and RLS. No production-readiness or complete-isolation claim.
