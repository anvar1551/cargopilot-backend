# Warehouse provisioning UI — finite supported checklist

Baselines: backend 947807c2e9d2e9de37d09486220e75dd5a7d0a5f; frontend f5c975214f17278845abb70e0aac564e23b993e2.

| Supported action | Contract and boundary |
| --- | --- |
| List/search | GET /api/warehouses?search=&page=&limit=; array, max100/page, shipment.view plus explicit warehouse scope; selected tenant context. No fabricated totals. |
| Detail | GET /api/warehouses/:id; safe warehouse fields, users:[], at most100 scoped operational order summaries. |
| Edit | PUT /api/warehouses/:id; shipment.update and explicit scope; name,type,location,region,latitude,longitude only. No server receipt/optimistic version: never automatically replay; persist uncertain write across reload for review. |
| Controlled create | POST /api/warehouses; warehouse.create, explicit company scope and accepted warehouse-provisioning.v1; mandatory operationId. Original authorized retry returns creation receipt, not current edited state. |
| Authority display | Add minimal authenticated no-store GET /api/warehouses/provisioning-authority using existing current accepted ownership/authority; no owner signing or grants. |
| Staff access | Existing /dashboard/manager/users; accepted operational warehouse ceiling required independently. Creation never extends scope or ceiling. |
| Unavailable | Delete, global assignments, owner authorization/revocation browser UI; no company ownership inference. |

Plan: additive authority read/tests; scoped frontend adapters and immutable creation/edit storage; replace old workspace/dialog and route alternate generic business creation to it; focused unit/API/owned PostgreSQL/browser validation; desktop/mobile/no-emit/lint; reviewed commits and updated coverage/readiness. Existing provisioning concurrency/custody/delegation evidence reused. No schemas, permissions or dependencies changed. Rollout read API before frontend; absent authority fails closed. Stop after this batch.
## Implemented and verified (2026-10-08)

The dedicated manager warehouse route and the generic business/warehouses route now use one workspace. The obsolete creation dialog and context-free write adapters were removed. Supported input fields are name, location, type, region, latitude and longitude; optional coordinates use progressive disclosure. List/search is server scoped and page bounded (20 in the UI); detail shows safe fields and the existing capped order summaries. No delete, assignment, invented total counts or owner-signing interface is presented.

The additive authority read returns only profileRevision, companyMembershipId, companyId, tenantId and accepted:true. It reloads membership and accepted authority, checks warehouse.create/company scope and active ownership, returns no-store, and writes nothing. This is an advisory snapshot; POST independently locks and revalidates. Backend must roll out before the frontend. No schema, permission, profile or dependency changes.

Creation persists and verifies a normalized intent before network work, bound to API origin and the complete selected identity/context. Web Locks and an in-tab guard prevent overlapping submission. Matching explicit retries preserve operationId/content across reload; conflicting edits cannot replace an intent. Context/epoch changes suppress late results. Creation receipts display the original snapshot and never overwrite edited detail or confer access.

Editing uses the existing PUT contract. Its local operation ID is a client intent identity only; it is not a server receipt. No automatic retry, uncertain-intent deletion or claim of optimistic concurrency is added. Unknown outcomes remain frozen across reload pending review; only confirmed or definite rejected updates can be finished. There is no implemented reconciliation mechanism to clear an uncertain update.

## Evidence executed versus reused

- 12 distinct client adapter/intent cases passed: supported fields and normalization, conflicting reuse, persistence/readback failure before send, restart/matching retry, missing/changed context, late responses, uncertain creation/edit handling, wrong edit receipt, bounded reads and secret-safe projections. Command: installed Node --test tests/warehouse-workspace.test.cjs.
- 8 distinct mocked backend cases passed: mandatory context, minimal/no-write/no-lock authority read, revoked/foreign/missing accepted authority, permission alone, missing scope and suspended membership. Command: installed Node node_modules/jest/bin/jest.js --runInBand tests/security/warehouse-provisioning-discovery.test.ts.
- 8 distinct actual HTTP/PostgreSQL cases passed against owned run 43b6043c8dfb: minimal no-store read without writes; create/matching retry producing one receipt with no access/ceiling grants; conflict/foreign reuse/ownership-field rejection; revoked authority denying fresh reads and confirmed retry; explicitly scoped list/search/detail/six-field edit; original creation receipt retained after edit; foreign/anonymous/page-bound denial without writes; approved operational ceiling -> staff invitation/acceptance/selected login -> scoped warehouse visibility, with creation/edit denied to staff.
- These database cases completed across affected tail runs after test-fixture corrections, not one uninterrupted all-green run. Initial test defects included endpoint/profile names, SQL timestamp setup and a test-only editor fixture using the wrong Prisma relation. The owner-ceiling operation committed independently; its state was explicitly verified, and the editor prerequisite was separately provisioned in the owned database. Final test source now requires the fixture host to return success; this stronger setup assertion was syntax-checked, not counted as a new database case. The external host must use Role.rolePermissions/Permission.key and complete its fixture before returning 200. No application mutation defect or permission expansion was used to make the journey pass.
- One actual browser/API/PostgreSQL journey: accepted authority -> create all six fields -> reload -> matching retry -> one warehouse/receipt -> separate synthetic owner-approved resource ceiling and explicit editor scope -> fresh login -> search/detail/edit -> named approved resource in the existing staff selector. The edited name differs from the original creation snapshot, as intended.
- Desktop 1440x1000 and mobile 390x844 inspected; document width 375 at viewport 390. Screenshots saved outside repositories under the Codex visualization warehouse-provisioning directory. Native device behavior is not demonstrated.
- Final frontend no-emit and focused ESLint passed. Backend default-heap no-emit initially exhausted its heap; rerun with Node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit passed. The final API evidence test was syntax-checked with Node --check.
- Existing DOM-02 provisioning uniqueness/concurrency/rollback, delegation mutation/revocation, custody and Socket.IO evidence reused only for unchanged exercised source. The 122 unchanged migrations prepared the empty test database; no new migration-chain or concurrency evidence is claimed. Storage/providers, Redis admission/cache and unrelated background boundaries were mocked; no live infrastructure accessed.

## Boundaries, prerequisites and cleanup

Warehouse owners remain tenants. Creation company is immutable audit context, not exclusive company ownership. Accepted provisioning does not add read/edit scopes or operational warehouse ceilings. Editing evidence uses a deliberately explicit pre-existing synthetic shipment.update role plus warehouse scope; no newly approved editor provisioning profile is implied. The staff selector used a separate controlled owner approval, never a browser signing action or automatic creation side effect.

The existing auth layout emits nested html/body hydration warnings during login; inspection traced these to unchanged root/auth layouts. They did not prevent the connected journey. This is an existing client follow-up, not a new warehouse defect or an all-clean browser-console claim.

Owned PostgreSQL container cp-verification-43b6043c8dfb/tmpfs and API key-registry temporary file removed after ownership checks; loopback listeners 4340/3240 stopped and absence verified. Automatic approval review rejected removal of C:\Users\Anvar\AppData\Local\Temp\cp-frontend-warehouse-ui-owned-loZwml; left for manual cleanup without retry or bypass. All earlier blocked directories, dist, unrelated work and the unexpectedly installed Python runtime remain untouched.

Next finite milestone after external review: financial-actor administration discovery/UI using the existing accepted independent grant authorities and minimal scoped selectors; define its contracts before implementation. Not started. Owner registration/signing, real provisioning/email delivery, native driver, finance/cash and production verification remain outside this batch.
