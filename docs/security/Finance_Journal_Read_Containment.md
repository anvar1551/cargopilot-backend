# Journal read containment

Baseline: 0755c6e27928442fdffb93cbb09940893a493143. Plan: trace list/detail callers and the inspected frontend DTO; require fresh selected finance context; scope parent, nested records and cursors; project safe exact-money fields; verify source predicates against an exclusively owned disposable PostgreSQL instance. No successful financial mutation, new accounting/FX policy or historical data repair.

## Enforced read boundary

GET /api/finance/journals and /journals/:id, FinanceService and repository entry points require the complete fresh selected actor, finance.journals.read and explicit stored selected-company scope. Active matching tenant/company/legal entity is required. Null/foreign/inactive finance ownership hides records. No read creates configuration. Internal signatures now require AppUser instead of companyId; no company-only fallback.

Journal document, each line account, non-null account parent and reversal reference must have the same legalEntityId. Conflicting nested ownership hides the entire journal from list, cursor and detail; amounts are not recalculated and lines are not silently omitted. This prevents exposing another entity's document/account through legacy single-column foreign keys. It is application read containment, not a database integrity constraint or accounting approval. Inactive historical accounts remain readable when ownership agrees. SourceType/sourceId scalar references remain part of the document DTO; their financial acceptance is not certified and no source object is expanded.

Lists accept only cursor/limit, limits1..100; detail IDs and cursors are UUID-shaped. Owned cursor uses createdAt/id descending keyset. Foreign/hidden cursors/details return404. List count is limited to that eligible journal's related lines. Explicit DTOs omit metadata, posted/reversed actor IDs, line dimensions and broad nested records. Decimal values remain Prisma Decimal/string serialization without Number arithmetic. Detail fetches at most501 lines and rejects409 FINANCE_JOURNAL_DETAIL_LIMIT above500 (existing creation HTTP limit); no partial financial document is returned.

Inspected frontend lib/finance.ts listFinanceJournals/getFinanceJournal and JournalsWorkspace use supported fields/pageInfo. No client edits or browser verification. Unknown filters now reject400. Draft/post/reverse and internal transactional findJournal/journalInclude remain outside this read slice and require separate authorization/approval review. Fresh checks cannot guarantee revocation after the last database read or a transactionally frozen view across all nested queries.

Rollback must retain read scope or disable reads. Existing invoice/configuration/period write containment and historical NOT VALID limitations remain intact.

## Evidence and remaining work

node node_modules/jest/bin/jest.js --runInBand tests/security/finance-journal-read-containment.test.ts:25 new mocked/HTTP cases passed. Actual read helper/classifier with mocked membership/database evidence; no transaction/business writes asserted for every case. Not real transport or posting concurrency evidence.

PostgreSQL and final no-emit results are recorded in the backlog after execution. No new schema or migration/client generation required. Prior unrelated suites are reused unchanged rather than rerun. Any accepted invalid nested reference is an integrity gap, not a successful isolation test.

Release gates remain: approved invoice pricing/FX; independent sensitive configuration/period approval; approved cash mappings; broader journal/finance mutations; nullable ownership and historical constraint certification; distributed revocation/Redis/provider/storage recovery; broad repository scoping and RLS. No production-readiness claim.
