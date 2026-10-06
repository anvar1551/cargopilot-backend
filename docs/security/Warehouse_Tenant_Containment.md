# Current creation follow-up (2026-10-06)

[Warehouse_Provisioning.md](Warehouse_Provisioning.md) supersedes the historical
creation-capability gap below: creation now requires explicit accepted owner authority
as well as warehouse.create and selected company scope, with durable operationId.
The new migration inserts reserved permission metadata only; it remains outside
SYSTEM_PERMISSIONS automatic grants. Creation grants no warehouse scope/ceiling.
Read/update/assignment containment below remains enforced. Real provisioning and
client rollout remain unperformed. The original report below is historical evidence.

# Bounded warehouse management containment

## Plan, baseline and current enforcement

Proof checkpoints: backend 25fe290d1ac4fe3148c0c80d9fe1da0cf7c48573; driver b7040eadf47850fa6f8392a45c6b7370c03125da. Reviewed proof manifests were committed separately, with staged filename/whitespace/credential-pattern checks and unchanged recorded validation. Proof evidence remains 18 distinct PostgreSQL cases, a final six-case rerun, 24 backend boundary cases and 24 driver cases with one affected rerun, not additive case totals. S3/device/reconciliation limitations remain open.

Plan: enforce fresh selected membership plus explicit warehouse scope at repository boundaries; scope nested order projections; derive new tenant ownership; contain global assignment writers and the direct legacy map directory consumer. No new schema, constraints, services or runtime seed execution. Warehouse changes remain uncommitted.

Current enforced behavior in this slice:

- GET /api/warehouses: shipment.view AND fresh full user/tenant/tenant-membership/company/company-membership agreement AND explicit warehouse scopes on that selected membership. Tenant/company scope, manager roles, User.warehouseId and DriverWarehouseAccess alone never grant directory access. Lists hide tenant-null and foreign rows. Optional search (name, 120 characters), page (1..10000), limit (1..100, default 100) preserve the array response with bounded stable ordering.
- GET /api/warehouses/:id: same directory policy. The selected warehouse filter includes tenant and explicit IDs. Nested orders additionally require matching tenant, selected owner company AND the existing fresh order permission/object policy. At most 100 recent orders, stable ordering; this is a bounded subset, not a total count. The global users relation is neither queried nor returned; users remains [] for response-shape compatibility. User membership/warehouse assignment cannot establish a membership-specific operational assignment. There are no standalone warehouse count, autocomplete, assignment or DELETE routes in warehouse-core; search uses the list route. No unscoped related counts are introduced.
- PUT /api/warehouses/:id: shipment.update AND the same fresh explicit warehouse scope. The SQL update predicate itself retains ID, tenant and allowed scope, rather than relying on a prior existence read. Legacy, foreign or unscoped IDs cannot mutate. Existing safe projections remain.
- POST /api/warehouses: requires a separate explicit warehouse.create capability AND selected-company scope on the verified membership. Only tenantId is derived from its authoritative snapshot. No company-owner relationship or automatic access grant is created. This reserved capability is deliberately not registered with automatic system permission/owner-role seeding. Existing shipment.update alone is insufficient; until a separately reviewed capability provisioning decision is implemented, existing clients' creation remains unavailable. Positive tests use a mocked explicitly granted capability, not evidence of a deployed grant. No database permission/role rows were created.
- Transport and repository write boundaries both accept only name/type/location/region/latitude/longitude. Ownership fields and all nested relations (users, drivers, orders, organizations, tenant) reject instead of being silently stripped or becoming Prisma authority.

## Assignment containment and inspected callers

Only warehouse transport calls the four warehouse repository exports; their signatures now require context. Direct warehouse access was also found in driverProfileService and liveMapService. Driver profile PUT /api/drivers/:id rejects primaryWarehouseId and warehouseIds, including clearing values, before lookup or transaction. Administrative user PATCH rejects warehouseId and new warehouse scope grants before membership lookup or any name/role/scope mutation; normalization matches the existing scope parser, including whitespace/case variants. The alternate createUserByCompanyAdmin service also rejects these warehouse assignment/grant fields before reads/writes (HTTP enrollment remains separately contained). Global User and DriverWarehouseAccess links cannot express tenant plus selected company-membership assignment. Existing stored links are not rewritten or silently mapped. Removing a warehouse scope through a replacement list without warehouse grants remains possible; general administrative grant ceilings are not fixed here.

The legacy live-map actor lacks selected membership/tenant context. Its direct warehouse directory query is now explicitly empty (id in []), preserving warehouses: [] instead of using an unfiltered query or user-global assignment. This containment is source-reviewed; no live transport/Redis test was performed. Broader live-map order/driver queries, presence, manager/driver directory reads, analytics, bootstrap scripts, dispatch/scan/transfer workflows and global assignment consumers retain earlier gaps outside this management slice. Do not describe this as complete warehouse or tenant isolation.

No delete path is added, and no existing relation delete policies are changed. Existing operational-reference restrictions remain; deleting a warehouse via a future API requires a separate scoped reference/workflow review.

## Compatibility, unresolved decisions and recovery

Reviewed frontend lib/warehouses.ts still expects array lists and scalar write payloads; lib/manager.ts uses directory reads and driver assignment writes. Scalar payload/DTO shapes continue; permission provisioning, explicit scopes, bounded list pages and blocked assignment writes are behavior changes. Current frontend fetchWarehouses does not paginate; it sees at most the first 100. Driver assignment UI requests now reject safely. Detail users is empty, nested orders are bounded/scoped, and live-map warehouse markers are suppressed. No clients changed; no browser/device compatibility claim.

Decisions required: which tenant roles may receive warehouse.create, how reviewed explicit warehouse grants are provisioned without general admin escalation, and whether operational user/driver assignments are tenant-wide or selected company-membership-specific. Do not invent a company owner for Warehouse from organizational hierarchy or user links. A future membership-bound assignment model and reviewed grant policy are prerequisites to restoring assignment mutation and user directory projections. The new create capability does not certify general RBAC safety.

This is application containment over nullable expansion. Null ownership remains in the database and is hidden here; no backfill or non-null cutover. Fresh checks narrow cache delay for these operations but do not remove revocation races between authorization and SQL execution. No transaction/constraint behavior was added, so new disposable PostgreSQL execution was unnecessary; earlier PostgreSQL proof evidence is reused only for unchanged proof code. Rollback must retain these gates or disable affected APIs, never restore global queries.

RLS remains deferred defense in depth. Proof incomplete reconciliation tooling, real S3/device behavior, codec ownership, provider recovery, Redis lifecycle/backpressure, refresh-family redesign, broader repository scoping, finance/payment blockers and all earlier release gates remain open. No production readiness claim.

## Changed files and evidence

Uncommitted files: src/modules/warehouse-core/application/warehouseAccess.ts (new), warehouseRepo.ts, warehouseProjection.ts; src/modules/warehouse-core/transport/fastify-routes.ts; src/modules/driver-core/application/driverProfileService.ts; src/modules/identity-access/application/auth.service.ts; src/modules/live-map-core/application/liveMapService.ts; tests/security/warehouse-tenant-containment.test.ts (new); tests/security/warehouse.phase0a.test.ts; this report (new). Permission registry is unchanged.

- node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse-tenant-containment.test.ts tests/security/warehouse.phase0a.test.ts: 46 passed (35 new ownership/assignment/query cases, 11 affected response-boundary cases). Actual repositories/auth service and Fastify injection with mocked Prisma/membership state; query predicates and unchanged records are asserted. This is not PostgreSQL, concurrency, Redis or transport evidence. No storage, jobs or providers are called by these covered paths.
- The initial affected projection runs failed one obsolete users expectation, with other cases passing. It was corrected to assert users: [] and absence of a users select, preserving sensitive-field coverage.
- One subsequently added HTTP ownership/nested-field rejection case was run separately; result recorded below. Earlier passing cases were not rerun unchanged.
- node node_modules/typescript/bin/tsc --noEmit: passed after application and assignment-guard changes. No generated clients, build/dist writes, dependencies or migrations.
- Focused diff/whitespace and credential-pattern review: recorded below. No warehouse changes staged. Existing dist and unrelated work preserved. No service access, push or deployment.

Final focused HTTP check: node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse.phase0a.test.ts --testNamePattern='HTTP ownership': 1 passed, 11 unchanged cases skipped. Total distinct warehouse evidence: 47 passing cases (35 new ownership/assignment cases and 12 affected boundary cases), assembled from the 46-case run plus this one new case; not a final full 47-case run. Focused tracked/new whitespace checks and credential-marker scan passed; test credentials inspected as synthetic. Final intended worktree scope is the ten files above, unstaged.
