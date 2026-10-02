# Template configuration/action publication foundation

Current enforced behavior in this slice: additive empty immutable typed version
and leg history, exact tenant/company/actor membership bridges and atomic
expected-revision publication of existing owned configuration. The backend-only
publisher uses fresh integration.routing.manage and explicit selected company
scope. It does not author scalar changes, issue provider requests, approve
financial pricing, retire versions, or reaccept jobs. Public create/update/delete
continue their existing409 containment. No client or worker contract changes.

Plan and implementation: existing company/template and template/child targets are
reused; new compound version targets bind current pointer and typed children.
Existing templates start revision0/null without inferred historical acceptance.
Each tenant-scoped operation binds normalized template ID and expected revision;
fresh authorization precedes every receipt return. Matching retries return the
original minimal receipt; changed revision/context/user/company conflicts.
Tenant-operation advisory locks serialize cross-template/company reuse, parent
FOR UPDATE serializes publications, and the actual scoped write compares the
old revision/pointer. Receipt, typed leg snapshots and pointer commit in one
bounded transaction (2s admission,5s transaction,3s statement,1s lock).
One publication per template per transaction is supported.

Snapshots explicitly include template name/code/active/priority/service/mode/
countries and each owned leg identity/sequence/code/label/mode/countries.
Arbitrary metadata and credentials are not copied, projected or logged.
At most100 legs,2048UTF-8 bytes per text field and64KiB serialized selected text
are admitted by the publisher; SQL enforces per-field bytes and aggregate raw text.
These different bounds are documented rather than represented as equivalent.
Receipt returns id/templateId/revision/operationId/server acceptedAt only.

SQL protects UPDATE/DELETE/TRUNCATE of version and leg snapshots. Child INSERT
requires its parent version's creating transaction, stamped server-side even if
a raw insert supplied a different transaction ID. The transaction identifier is
internal sealing metadata, never an API value. Deferred receipt checks reject
unpublished accepted records; deferred current snapshot checks enforce full
typed parent/child equality and count. Parent publication cannot clear history or
skip revisions. Source leg writes lock old/new parent rows in UUID order before
mutation so that deferred checks cannot race publication against an old pointer.
Database deadlocks/timeouts remain possible and reject/roll back; no retry loop
or exactly-once provider claim is introduced.

Legacy template0/null remains a transitional current configuration, not accepted
history. Once a snapshot is published, direct scalar/leg edits that disagree
fail unless a consistent new version is atomically published in the same
transaction. Historical leg identities referenced by snapshots cannot be deleted
or reparented. Current publisher does not implement that authoring workflow.
Source-leg TRUNCATE is rejected, including for unpublished templates, to prevent
bypassing row-level guards. Existing safe reads/selector/seed contracts remain.
No existing rows are backfilled or certified. Full-chain disposable validation
does not establish deployed migration readiness.

Rollback must retain immutable records, relationship guards and write containment;
do not drop history/constraints to restore unscoped or in-place edits. Migration
was applied only in newly owned disposable PostgreSQL. Prisma models reflect
columns/relations/indexes, not CHECK/trigger semantics; offline syntax and focused
source-to-SQL/catalog review are distinct from full semantic equivalence.

Validation and exact owned cleanup evidence are recorded in the backlog. Native
commands: installed Node `%TEMP%/cp-cash-schema-check.cjs` (offline Prisma
validate/ignored generation), `node_modules/typescript/bin/tsc --noEmit`, Jest
`--runInBand --runTestsByPath` for template-configuration-publication,
integration-template-access and integration-routing-selector:46passed (12new).
`%TEMP%/cp-template-publication-final-run.cjs` applied96migrations/12pass with
one unrelated shared-fixture inventory failure; isolated shared-search correction
`%TEMP%/cp-template-read-correction-run.cjs` passed1affected case. Eight distinct
new publisher native cases and five affected cases pass, not reruns added together.
All three owned tmpfs instances (427dbb40f9f1,948f8280a20e,092e5041c4e3) were
checked/removed and filtered absence verified. Initial new mock Date/string
fixture failure corrected without application weakening. Final no-emit passed.
The previous191case milestone is reused only for unchanged behavior, not claimed
as a new run against these SQL constraints.

Native
cases run actual publisher, membership helpers and Prisma transactions with only
the configured Prisma import redirected to the guarded test database. Storage,
provider, Redis, client/device and real transport behavior are not established.
Permission/status changes after the authority read remain a timing boundary; this
foundation is not immediate distributed revocation.

Remaining policy-dependent behavior: accepted-job configuration/credential version
selection, cancellation/reacceptance and retirement are undecided and unchanged.
Routing immutable version/action publication is the next technical slice.
Provider recovery, independently accepted pricing/FX/accounting and checker
eligibility, nullable/NOT VALID history, provisioning, RLS, Redis resource lifecycle
and native transport/infrastructure remain release gates. Containment is not
restored configuration management or complete tenant isolation.
