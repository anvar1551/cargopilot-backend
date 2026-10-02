# Selected route templates and automatic routing

Current enforced behavior: list/detail/cursor/count require a fresh selected
membership, `integration.routing.read` and explicit company scope through the
established integration helper. Owner company/tenant must be active. No aggregated
membership or policy override fallback. Reads use bounded read-only RepeatableRead
transactions (2s admission, 5s transaction, 3s statement, 1s lock), explicit scalar
projections, at most 100 returned templates and 100 legs per template. More legs
reject with `INTEGRATION_READ_CAPACITY`; no truncated detail/count claim. Raw custom
template/leg metadata is no longer selected and compatibility fields return null.

Template create/update/delete are contained409 after fresh manage/company scope
and, for existing records, selected id-only ownership lookup. No in-place rewrite,
nested leg deletion or business effects. Public non-financial configuration remains
unavailable until durable immutable configuration versions/actions and controlled
retirement exist. This is containment, not restored configuration management.

Automatic routing now requires an actor and established fresh parent-order
`shipment.bookCarrier` authorization; company-only calls no longer compile. The
selected company must own the order, matching existing durable booking constraints.
Within a bounded read-only snapshot, it reloads the child under active tenant/owner,
checks structured address tenant ownership before selecting country data, verifies
the leg's configured template/child, and scopes primary/fallback providers and
templates to that same active company. Legacy conflicting/missing template bridges
are excluded. Selection retains existing predicates and priority, adding id as a
deterministic tie-breaker. No fallback provider substitution or generic worker bypass.
The sole automatic-booking caller supplies its actor; the downstream booking method
still reauthorizes and applies durable ownership/workflow rules before effects.

Authorization at selection and later booking are distinct checks. This does not
eliminate concurrent revocation/configuration races, establish immutable config
acceptance, or guarantee provider recovery/exactly-once delivery. No worker, finance
policy, pricing calculation, client or external provider contract was redesigned.

Compatibility: existing list/detail envelopes and event contracts retained with
bounded default arrays, metadata:null, selected-company-only access and sanitized
HTTP errors. Template mutations return the existing routing controlled-workflow
code. Assigned-company-only booking selection is denied consistently with the
existing owning-company durable booking requirement. Clients deferred; no browser
or real-device compatibility claim.

Validation: first 56-case template/HTTP run had 55passes/1mapper-canary failure.
Explicit mapper nulling corrected it; 61 affected unit/HTTP cases then passed.
Routing/template milestone:129 passing unit/HTTP/order-child cases, final no-emit
passed. Actual template read/cursor/count/fresh-scope case passed at90migrations in
owned698568a581db; cleanup verified. Actual selector query/current parent/fresh tenant case passed at90migrations in
owned1bfd41d40944, identity/storage/label-filtered cleanup verified. Two distinct new
native cases for this slice, not added reruns.
Native query evidence does not establish provider/storage/Socket.IO transport.

Commands: installed Node node_modules/jest/bin/jest.js --runInBand --runTestsByPath
tests/security/integration-template-access.test.ts
tests/security/integration-routing-selector.test.ts
tests/security/integration-routing-read.test.ts
tests/security/integration-routing-mutation.test.ts
tests/security/integration-provider-http.test.ts tests/security/order-child-access.test.ts;
node_modules/typescript/bin/tsc --noEmit; existing guarded disposable runner
%TEMP%/cp-template-scoped-run.cjs and cp-routing-selector-run.cjs, native file
integration-metadata-postgres.integration.test.ts with only the new case pattern.

Next independently ready source gap: orders-legs/pricing.ts private template loader
still queries id/active without company/tenant, and the exported seed's parent
permission alone does not prove selected owning-company financial authority. Inspect
the exact normal-create/import consumers before narrowing these references; retain
best-effort seed/partial-import behavior and all pricing/FX/acceptance containment.
OrderLeg template company/child relationships lack the new routing-rule constraints;
source checks here are not database certification of that separate graph.
