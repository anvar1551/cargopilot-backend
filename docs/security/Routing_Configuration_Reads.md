# Selected template and routing configuration history reads

Current enforced behavior: additive GET /route-templates/:id/configurations and
GET /carrier-routing-rules/:id/configurations, under the existing integration
route prefix. Fresh integration.routing.read, active selected tenant/company
membership graph and explicit company scope precede any protected query.
Owned parent lookup, version list/count and cursor repeat tenant/company/resource
and current active owner-company predicates. Same-user sessions in other tenants
or other companies gain no aggregated access.

Execution plan implemented: shared readonly pagination for only these two explicit
resource types, resource ID and optional cursor UUID validation, limit1..100
(default25), descending unique revision keyset, at most limit+1 rows and scoped
total. Read-only RepeatableRead transaction uses2s admission/5s transaction/
3s statement/1s lock deadlines. Invalid cursor denies; no optional/global context
fallback. No child contents, provider credential/version pointers, operation/hash,
actor/membership identifiers, creating transaction, arbitrary metadata/conditions
or exact pricing fields are selected or returned.

Response is additive:
resourceId/currentRevision/currentConfigurationId,
data [{id,revision,acceptedAt,isActive,priority}],
total and pageInfo {limit,hasNextPage,nextCursor}.
A revision0/null resource returns empty history without provisioning or accepting
configuration. CurrentConfigurationId identifies a safe journal row; it is not a
credential or authorization receipt. Every access still requires fresh current
membership proof. Existing inventory/detail DTOs, mutation containment and
event contracts are unchanged. New HTTP schemas are strict: client tenant/company
selectors and unknown query fields reject400. Handler errors use existing sanitized
integration read envelopes and never log raw error contents.

No new schema/migration; syntax/native constraint evidence reused from unchanged
97migration foundation. This slice adds query/HTTP tests only. Mocked HTTP auth
prehandlers do not prove actual deployed authentication or browser/device behavior;
service tests and native current membership queries provide their stated evidence.
HTTP consumers are the two new route handlers; no worker calls or context-free
exports are introduced. Clients remain deferred.

The actual native tests use synthetic two-tenant/three-company fixtures and
authoritative configuration publishers in a newly owned disposable database.
They verify full counts/page/cursor isolation, safe keys, current pointer,
unpublished empty history, missing context, revoked roles and missing company
scope, and unchanged business/journal/outbox records across all reads/denials.
Exact commands/results and resource cleanup are in the backlog.

Remaining boundaries: concurrent revocation after proof/read snapshot, distributed
cache/socket revocation, historical nullable/NOT VALID certification/provisioning,
RLS, real Redis/storage/native infrastructure; backend foundation/read metadata do
not restore public authoring, rotation, cancellation/reacceptance/retirement,
worker version selection or provider recovery. Financial pricing/FX/accounting
and checker decisions remain contained, not inferred from configuration history.
Rollback must preserve authorization/containment and immutable history; do not
restore global queries or erase accepted versions.
