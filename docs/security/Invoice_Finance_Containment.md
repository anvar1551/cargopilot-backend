# Unsupported invoice finance execution containment

Baseline: d56512673c62010a7e4c64161beb4ece0eb5bc08.

## Plan and inspected boundary

Trace generic source ingestion from FinanceService and the durable queue adapter, processSourceEvent from the finance worker, and HTTP source-event retry. Block only unsupported invoice source execution before financial writes; preserve accepted cash authority and existing exception handling. No new accounting rules, conversion policy, schema, migration or generalized financial authorization fallback.

## Enforced source behavior

A single deny helper identifies invoice sourceType, invoice eventType and invoice source-event prefixes, including conflicting persisted payload markers. Generic repository ingestion denies before opening a transaction; a committed outbox or signed upstream input is not proof of invoice acceptance. Stored posting rows are checked before the posted shortcut, payload normalization, legal-entity/rule evaluation, numbering, journal/document/subledger/audit/outbox writes. Retry cannot reset an unsupported invoice exception to pending.

Existing processing catches this controlled finance error and may update bounded exception metadata for non-posted sources. Posted rows are excluded by the existing conditional update and remain immutable. This is containment, not a new invoice worker capability. Already-posted invoice delivery cannot be claimed as a validated idempotent success under this missing contract. Existing queue retry/poison-message behavior is unchanged and remains an operational release gate; no immediate retries or automatic uncertain outbound replay were added.

Cash custody handling remains under its existing durable acceptance checks; payment/refund/carrier/payable policies are unchanged, not certified by this slice. A dishonest producer labeling invoice economics as another source type is not addressed by marker-based containment; each remaining source requires its own authoritative domain binding. General finance HTTP/repository scoping remains open. No network or storage calls were introduced.

## Compatibility and recovery

Previously ingestible unaccepted invoice sources and legacy invoice posting/retry now reject with FINANCE_INVOICE_AUTHORITY_REQUIRED. Exception list response shapes and cash paths are unchanged. Restoration needs an approved durable invoice pricing/FX snapshot, ownership/legal-entity constraints, narrow execution capability and concurrent/rollback posting tests. Do not fabricate mappings, relabel events, edit posted entries or restore the generic invoice fallback during rollback; keep it contained instead. Existing source/outbox records are retained for reconciliation, with retention policy still unresolved.

## Validation

Executed: node node_modules/jest/bin/jest.js --runInBand tests/security/invoice-finance-containment.test.ts tests/security/cash-finance-authority.test.ts tests/finance/finance.service.test.ts: 49 passed (17 new invoice mocked cases, 29 affected cash mocked cases, 3 affected service cases). Assertions cover ingestion-before-transaction, inconsistent markers, legacy and posted processing, retry denial, no journal/document/numbering/audit/business-outbox writes, and existing cash behavior. No transport/database-posting evidence is claimed.

Executed: node node_modules/typescript/bin/tsc --noEmit: passed after the final guard/test changes. No new PostgreSQL constraints or transactional writes were added. Earlier eight invoice PostgreSQL receipt cases and 16 distinct cash PostgreSQL cases are reused only for unchanged exercised paths, not evidence that these new invoice guards ran in PostgreSQL. Dist and unrelated work remain preserved.

## Open boundaries

New invoice issuance and approved exact pricing/FX acceptance remain blocked; invoice posting accounting/provenance is not implemented. All previous mission release blockers remain open. This is not production readiness.
