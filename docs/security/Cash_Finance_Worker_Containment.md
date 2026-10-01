# Bounded cash-to-finance worker containment

Baseline: backend c648e430ef54cfc2f96bbe82fc56681b3085ab92. Changes remain uncommitted. Client checkpoints: frontend 69f102367eced2d88583778a46ceae0ca0613086, driver 76a07e649954d709a037cb3a110e073e320c7628. Focused partial-bulk ambiguity corrections were committed separately without rewriting those checkpoints: final frontend HEAD 24c6d23ba813a3a0439225d2eb6c698ce946db89 and driver HEAD 6410b609becc8f517e9e99345a45887ba5c062e8.

## Plan and boundary

1. Resolve Redis event identifiers to committed analytics outbox records; ignore queue business fields.
2. Reconstruct cash finance authority from the accepted custody receipt, event, collection, order, owning company/tenant and legal entity. Validate the acceptance-time FX snapshot rather than current mutable pricing.
3. Serialize ingestion by durable source identity and posting by source row; preserve existing balanced posting, periods, rules, audit/outbox transaction and controlled reversal paths.
4. Exercise focused mocked paths and disposable PostgreSQL duplicate/concurrency/rollback assertions. Do not install accounting rules, backfill ownership or run an existing database.

No new schema or migration: existing company/source-event and legal-entity/document-idempotency uniqueness plus populated cash-receipt compound foreign keys are reused. Nullable/general finance ownership constraints remain incomplete. Rollback must retain this containment or stop the cash-finance worker; restoring Redis payload authority is unsafe. Redis's old full payload contract still works when its envelope ID resolves to the existing committed outbox. Payload-only or missing-outbox messages cannot create finance sources.

## Implemented source behavior

- Cash ingestion uses only `finance:cash:<event UUID>`. It reloads the committed receipt and child records, proves tenant/company/legal-entity relationships, active tenant/company/entity and exact amount/currency consistency, and checks immutable acceptance outbox metadata/digest equivalence. Unaccepted legacy records, null ownership, wrong children and conflicting source records fail closed.
- The narrow capability is `accepted_cash_finance_post`. Execution does not use a human access snapshot, select a membership or impersonate a login. Original initiating actor attribution remains in the existing finance columns; audit details additionally identify the execution capability. A dedicated worker audit-identity schema is deferred. Initiator logout/revocation does not cancel already accepted cash work; disabled owning tenant/company/entity blocks execution. This does not define a new cancellation/reacceptance policy.
- Receipt Decimal is authoritative. Legacy Float mirrors must agree exactly; they are not migrated or certified. FX/date/base-currency basis is the already committed cash outbox snapshot, not Redis/current pricing. Values needing more than the existing four-place finance normalization are rejected rather than silently rounded. Existing ledger conversion/rounding and supported currencies are unchanged; rate provenance and legacy monetary quality are not newly certified.
- Ingestion takes a transaction-scoped advisory lock before read/create and preserves matching existing sources, including posted ones. Conflicting reuse rejects. PostgreSQL uniqueness remains the durable backstop. Posting takes a cash source row lock and reloads it before checking authority/status. Posted retries only validate their result binding; they never edit journals/documents. Ownership/source inconsistencies do not repair posted records.
- Shared locks protect existing owner, receipt/event/collection/outbox, warehouse, period, rule and account rows while this transaction uses them. This is an implementation design, not yet PostgreSQL concurrency evidence. Configuration insert/phantom races and broader finance concurrency are not certified.
- Only existing active legal-entity rules are evaluated. Rule accounts must belong to that legal entity. Missing/ambiguous rules, unusable accounts, closed/missing periods, unsupported currency/FX or unbalanced entries produce exceptions without journal/document/outbox effects. No cash accounting rule, account assignment, conversion policy or chart is installed. Test rules are clearly synthetic balanced mechanics, not proposed business accounting.
- Financial document, journal, subledger invocation, source posted transition, audit and finance outbox remain in the existing posting transaction. Rejection may update bounded source processing/exception metadata; it cannot write a journal or downstream finance business event. No network call occurs in the transaction. Controlled reversals are unchanged. Existing posted-record immutability outside these paths has not been independently certified.
- Non-cash queue entries now resolve their existing committed analytics outbox too; their domain ownership/posting policies are otherwise unchanged and remain outside this review. Cash cannot use the generic payload ingestion API. Queue retry/claim behavior is retained. Permanent bad messages remain pending under the existing policy; poison-message recovery and Redis backpressure remain open. Ingestion diagnostics use bounded error codes without payload/credential logging.

## Changed files

- `src/modules/finance-core/infrastructure/cash-finance-authority.ts` (new)
- `src/modules/finance-core/infrastructure/finance-queue-ingestion.ts` (new)
- `src/modules/finance-core/infrastructure/prisma-finance.repository.ts`
- `src/modules/finance-core/infrastructure/finance-subledger.projector.ts` (required advisory-lock result compatibility correction only)
- `src/workers/finance-posting.worker.ts`
- `tests/security/cash-finance-authority.test.ts` (new)
- `tests/security/cash-finance-postgres.integration.test.ts` (new)
- This report (new)

## Validation

Executed: `node node_modules/jest/bin/jest.js --runInBand tests/security/cash-finance-authority.test.ts tests/finance/finance.service.test.ts tests/finance/source-event.test.ts`: **36 tests passed**, including **29 new cash-finance mocked cases**. The affected existing service/normalization tests were run because generic ingestion and canonical source handling are used by the changed path. Mocked duplicate checks and transaction calls do not prove locking or rollback.

Executed: `node node_modules/typescript/bin/tsc --noEmit`: passed again after the final lock/test corrections. No schema/client generation/build was required; dist remains preserved. Focused whitespace review passed. The earlier credential-pattern review remains applicable to unchanged implementation; the new corrections add no credentials.

The earlier Docker startup blocker was resolved for this validation. `docker version --format '{{.Server.Version}}'` returned **28.4.0**. Backend HEAD remained **c648e430ef54cfc2f96bbe82fc56681b3085ab92** throughout; the worker slice and corrections remain uncommitted, with nothing staged.

Executed `node "$env:TEMP\cp-cash-finance-disposable-run.cjs"` using the existing isolated runner, targeting `tests/security/cash-finance-postgres.integration.test.ts`. The temporary runner stays outside the repository. Each attempt used a new labelled `cp-cash-finance-<run>` instance, cached PostgreSQL image with `--pull never`, loopback-only random port, synthetic credentials, 512 MiB memory, one CPU, 128 PIDs and 256 MiB exclusive tmpfs; allowlisted environment, run-marker checks, bounded connections/statements/test deadline and ownership-verified cleanup. All three database-test attempts applied the full current **70-migration chain**, without db push, a replacement schema or changes to historical migrations. PostgreSQL emitted existing long-identifier truncation notices; migrations completed successfully.

The first readiness attempt (`83c8a6469b55`) timed out starting a PowerShell sleep helper before migrations/tests. Only that helper was replaced with a bounded 500 ms in-process wait. The first database run (`670878f3fe6a`) produced **1 passed / 12 failed**: Prisma's PostgreSQL adapter could not deserialize the new ingestion advisory lock's `void` result. Casting the result to text preserves the acquired transaction lock. The next run (`2e4a7319518e`) produced **14 passed / 2 failed** across 16 cases, exposing the same pre-existing adapter incompatibility in the subledger lock used by cash posting. The identical result cast was applied there, without changing its key or transaction scope. The rollback assertion was strengthened to require the actual injected `synthetic outbox failure`, not merely any rejected promise.

Final affected PostgreSQL rerun (`004b314b19ab`): runner Jest arguments included `--testNamePattern=forged queue|concurrent posting|outbox failure`, yielding **3 passed / 13 intentionally skipped**. The remaining 13 passing cases from the preceding run are reused: their exercised rejection/ingestion paths were unchanged by the subledger result cast. This establishes passing evidence for all **16 distinct cases**, not a claim that a final full 16-test run occurred.

| Boundary | Actual PostgreSQL evidence |
| --- | --- |
| Accepted posting / forged queue fields | One owner-bound USD document for 100.2500; two journal lines; base debits and credits both 200.5000 using the committed FX snapshot; one finance outbox; posted retry leaves the result unchanged. |
| Duplicate ingestion / posting | Three concurrent ingestions resolve to one source; three concurrent postings produce one non-idempotent result, one document, one balanced journal and one outbox; source ends posted. |
| Foreign or conflicting authority | Foreign acceptance tenant, foreign source company, same-tenant foreign legal entity/account, inconsistent source ID/payload and suspended tenant reject; financial document/journal/outbox snapshots remain unchanged. |
| Missing acceptance / monetary inconsistency | Deleted acceptance receipt/outbox, missing source and altered cash-event amount reject; rejected ingestion creates no source; no financial posting/outbox effects. |
| Rule / period controls | Missing active rule and closed period remain exceptions, with no invented accounting or financial effects. |
| Transaction rollback | The injected finance-outbox trigger error is observed; document, journal, finance outbox, audit and number-sequence state remain unchanged; source remains pending. |

After each attempt, cleanup verified the exact container name/run label, exclusive tmpfs and absence of volumes/bind mounts before removal. All four resources (`83c8a6469b55`, `670878f3fe6a`, `2e4a7319518e`, `004b314b19ab`) were removed. Subsequent label-filtered Docker checks confirmed all four absent. No existing container/database or compose stack was used.

Affected offline reruns: `node node_modules/jest/bin/jest.js --runInBand tests/security/cash-finance-authority.test.ts`: **29 passed** after the ingestion lock correction. `node node_modules/jest/bin/jest.js --runInBand tests/finance/subledger.test.ts tests/finance/finance-subledger.service.test.ts`: **6 passed** after the shared lock correction. Unchanged earlier service/normalization evidence is reused. This is actual PostgreSQL evidence for the tested cash path and concurrency schedules; it does not establish all possible races, real Redis transport/worker lifecycle, deployed accounting rules or exactly-once external delivery. Test accounting rules remain explicitly synthetic mechanics.

## Outstanding release gates

Disposable PostgreSQL validation is complete for the covered assertions; review the uncommitted corrections before checkpointing. No accepted outbox may be pruned while required for cash financial validation; no automatic source pruning was found in the inspected application paths, but deployed retention is unknown. Missing acceptance/FX basis requires explicit reconciliation, not fabricated source data. Approved cash accounting mappings/configuration still need business review; synthetic fixtures cannot establish deployed rules. Legacy Float migration, general finance authorization/scoping, provider recovery, refresh/realtime revocation timing, client proof/payment/selection limitations, nullable tenant cutover, RLS, Redis lifecycle/backpressure and all earlier release blockers remain open. This is not production readiness. Membership-selection UI work has not started.
