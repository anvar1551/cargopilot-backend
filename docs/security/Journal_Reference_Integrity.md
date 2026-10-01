# Journal reference integrity

Baseline: 7b022485331647fe4083480029c0c6408c946c1f. PostgreSQL previously accepted foreign journal documents, reversals and line accounts. Plan: additive compound constraints; server-derived line bridge; checks at actual writers and retry receipts; preserve exact balancing/period/transaction/audit/outbox rules; validate only on new disposable PostgreSQL.

## Enforced behavior

Migration20261001190000_journal_reference_ownership adds compound document/journal targets and FKs for journal→document and both document/journal reversals. New nullable FinanceJournalLine.legalEntityId is constrained by compound journal/account FKs and a NOT VALID non-null CHECK. Required old line relations coexist with optional ownership relations. Existing single-column document/reversal FKs deliberately remain in SQL during expansion. No historical migration or record changes.

Actual writers are PrismaFinanceRepository.createDraftJournal, reverseJournal and processSourceEvent. Each derives the new line bridge from the authoritative entity/original journal. Manual service/repository/HTTP entries require fresh selected context, operation permission and explicit stored company scope. Command company/actor mismatch rejects before transactions. Journal reloads and row locks bind tenant/company. Workers reload authoritative durable source and active owned entity without human impersonation. All source types now require matching posting-account entity and stored source/company/entity before posting.

Posting/reversal/duplicate results validate journal/document/line/account and reversal ownership before effects or receipts. Null/conflicting/disabled graphs reject without repair. Journal row locks serialize manual posting/reversal. Existing exact balancing/open-period validation, separate reversal entries and transactional audit/outbox remain. No posted amounts/lines are rewritten. Existing mutation DTOs remain; broader response projections and manual approval are separate review items.

## Expansion and compatibility

Five compound FKs and the non-null CHECK are NOT VALID. They enforce new inserts/applicable changed keys without certifying old references. An unchanged old FK can survive unrelated updates. Old null line bridges survive migration; the CHECK blocks their updates and application graph guards/read predicates deny execution/receipts/content. Nullable Prisma fields represent this transition. Null reversalOfId intentionally means no reversal and bypasses the optional FK.

Legal-entity equality does not certify legal classification, active/non-null tenant ownership, financial approval or dimension ownership. Application checks require active matching non-null tenant/company. Existing FinanceLegalEntity nullable ownership/NOT VALID tenant constraint remains transitional. Direct SQL is not tenant authorization. Broader dimensions/audit/source/subledger constraints, posted-record immutability, durable manual approval, general accounting/FX rules and RLS remain release gates.

Deploy migration, reviewed generated client and source together; old writers omitting line bridges fail closed after CHECK. No zero-downtime rolling-write compatibility claim. Client generated offline into ignored node_modules because new field is used; dist untouched. No historical backfill/certification under this authorization. Rollback must retain enforcement or disable affected writes, never restore unscoped/conflicting writes.

Invoice pricing/FX/new issuance/execution and configuration/period containment remain. Synthetic cash mappings are not approved accounting policy. Current checks do not eliminate concurrent revocation after the last read or prove all schedules/external exactly-once delivery.

## Evidence

Offline Prisma validation initially found optional compound line-relation mismatch; separate optional ownership relations fixed it while preserving required old relations. Final validation passed using schema-only cp-cash-prisma.config.ts. Manual schema/source/SQL and selected PostgreSQL catalog checks establish targets/actions/unvalidated state, not complete semantic schema-to-SQL equivalence or historical certification.

Backlog records exact focused commands, initial fixture collisions, targeted reruns, distinct cases, final type checking and ownership-verified cleanup. No existing services, dependency/client repository changes, push/deployment or complete-isolation/production-readiness claim.

## Follow-on reversal retry binding

Existing entity-level idempotency keys could return an unrelated same-entity journal. assertReversalRetry now compares the stored reversal with original target/document, initiating actor, requested date/reason, source markers, exact document currency/FX/amounts, reversed totals and every swapped line amount/account/currency. Conflicting reuse returns409 FINANCE_REVERSAL_IDEMPOTENCY_CONFLICT without business effects. Matching authorized retries retain the original ID. Fresh selected context and graph validation remain mandatory.

10new unit cases passed. Disposable PostgreSQL full74chain:2new retry/competing-distinct-operation cases plus1affected valid concurrent-posting/same-ID-reversal case passed. Wrong target/actor/date/reason leave records/audit/outbox unchanged; competing IDs create one balanced reversal and one audit/outbox event. Broader immutable draft receipts and independent manual approval remain unresolved; no generic exactly-once, FX policy or acceptance claim. Cleanup of owned a59f34ac49c1 verified. Final type-check/checkpoint result is recorded in backlog.
