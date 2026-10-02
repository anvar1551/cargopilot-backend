# Carrier-routing configuration/action foundation

Current enforced behavior: new immutable typed routing versions and action
receipts, backend-only atomic publication of existing owned rules. Public
routing create/update/delete remain409-contained; no authoring, automatic
selector precedence changes, provider requests, worker cutover or client changes.

The additive expansion initializes existing rules revision0/null, not accepted
history. Versions bind tenant/company/rule, exact actor company/tenant membership,
tenant-scoped routing operation and expected/server revision. Mandatory primary,
optional fallback and optional template references bind exact immutable
configuration versions using existing compound owner/revision targets. A selected
template child must belong to that exact template version. Complete optional
bridges are CHECK-enforced, including explicit non-null revision checks (SQL
three-valued logic must not permit partial bridges). Nonfinancial carrier/active
provider-version semantics are checked by the application and deferred SQL.
Weights retain Prisma Decimal/DECIMAL(10,2), never Number calculations.

Execution plan implemented: fresh integration.routing.manage and explicit selected
company scope; tenant-routing-operation advisory lock; owned parent FOR UPDATE
and reload; normalized immutable rule/revision intent; matching/conflicting
receipt handling; sorted provider FOR SHARE locks and optional template FOR SHARE;
reload accepted active owned pointers; typed version INSERT and actual scoped CAS;
deferred receipt/current scalar agreement. Transaction deadlines remain2s
admission/5s transaction/3s statement/1s lock. At most two providers and one template
are inspected. Raw request ownership/version/snapshot fields are rejected.
Matching retries reauthorize and return their original minimal receipt, not a
newly selected provider version. No provider operation is replayed.

Snapshots contain typed routing predicates only: provider/fallback/template/
child IDs and exact version/revision bindings, name/code/active/priority/autoBook,
service/mode/countries, exact optional weight bounds and leg sequence. Text fields
are bounded2048UTF-8 bytes each. Arbitrary conditionsJson is excluded and current
rules with any non-SQL-null conditions cannot be published; its schema/evaluation
contract is undecided. This affects only the new foundation, not a claim that
current selectors evaluate or certify custom conditions. No credential values,
payloads, raw exceptions or arbitrary JSON are returned/logged. Receipt projection:
id/ruleId/revision/operationId/server acceptedAt.

Immutable versions reject UPDATE/DELETE/TRUNCATE. Current pointers cannot clear
history, skip revisions, or commit mismatched typed predicates; accepted receipts
cannot commit without publication. Immutable references retain past provider and
template revisions when those current pointers later advance. Publication locks
ensure current references agree at acceptance; this does not decide what version
an accepted worker should execute or automatically reaccept earlier jobs. Current
workers and selectors remain on their previously documented contracts.

Compatibility and migration: new empty typed history, no casts/default tenant/
historical ownership or acceptance backfill. Existing revision0/null rules remain
transitional. Published rule predicates cannot be edited without atomic consistent
new-version publication; the current publisher does not offer that authoring flow.
No HTTP endpoint was added. Rollback must preserve immutable audit history and
ownership guards or keep affected writes disabled, not restore in-place/unscoped
editing. Prisma syntax validation and selected source/catalog relationships are
distinct from CHECK/trigger semantic PostgreSQL evidence or deployed migration
readiness.

Exact validation is recorded in the backlog. Commands: offline
`%TEMP%/cp-cash-schema-check.cjs` validates syntax and generates
only ignored client types; `node_modules/typescript/bin/tsc --noEmit` checks source.
Installed Jest `--runInBand --runTestsByPath` for routing/provider/template
configuration-publication suites passed35cases (13new routing). Guarded
`%TEMP%/cp-publication-ownership-final-run.cjs` applied97migrations and passed
22distinct combined native cases (6provider/8template/8routing). Earlier
5case routing run and targeted additions are not counted again. New native
routing cases include exact-reference retention/revoked retry, same-company
noncarrier and inactive-template SQL/application rejection. Raw lock predicates
repeat verified company; affected assertion/type-fix evidence is in the backlog.
Every newly owned loopback/synthetic/tmpfs resource was name/run/storage checked,
removed and filtered absence verified; no existing resources were accessed.

Native tests use actual publisher,
fresh helpers and Prisma transactions through the exclusively owned guarded
adapter; Redis/provider/storage are not used. No real-provider, device, transport,
production, RLS or complete-isolation claim. Concurrent revocation after the
authority read remains a timing boundary.

Remaining decisions: accepted-operation configuration/credential-version
selection, controlled cancellation/reacceptance/retirement, uncertain provider
recovery; custom condition contracts before their publication. Financial
configuration requires independently accepted immutable rules/eligible separate
checker, exact pricing/FX/accounting acceptance; none is invented or restored.
All previous historical/null, provisioning, Redis/native infrastructure and
deferred-client release gates remain open.
