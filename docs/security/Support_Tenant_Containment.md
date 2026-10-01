# Support tenant containment

## Scope and plan

Warehouse checkpoint: f666e25d4b3b0cf508124ad2074c134b4d8e0fcd (`feat: contain warehouse access within tenant scopes`), based on expected 25fe290d1ac4fe3148c0c80d9fe1da0cf7c48573. Its reviewed ten files were committed after exact staged-manifest, whitespace and credential checks. Warehouse evidence remains 46 passing cases plus one separately executed HTTP case: 47 distinct cases, not a final full 47-case run. Assignment/provisioning and client pagination limitations remain open.

This support slice adds nullable authoritative ticket ownership, gates all existing support entry points through fresh selected membership and existing scope helpers, keeps mutations/history/owned notifications/domain outbox in PostgreSQL transactions, and contains producers/streams without durable ownership. No historical inference, backfill, client changes or broad worker redesign. Rollback must preserve these gates or disable affected operations; it must not restore global access.

## Current enforced behavior

- Lists, search, summary counts, details, messages, internal notes, status/escalation, assignment, assignee directory and queue/rule management require the complete selected user/company-membership/tenant-membership/company/tenant tuple. Current active eligibility and action permissions are reloaded. Tenant and selected owning company predicates accompany the existing support object/customer scopes. Linked tickets additionally require current shipment permission/object scope on their parent order. Caller `scopeWhere` compatibility parameters cannot override server filters.
- Creation rejects request ownership fields, nested relations and unsupported fields. The verified selected membership determines tenant and owning company. Order ID/number must agree, and selected-company order, customer master and warehouse access controls must authorize linked references. Referenced driver/customer identities need an active bridge in that selected company. Existing routing/SLA precedence is retained inside selected-company configuration; another organizational unit needs a reviewed company binding and is currently rejected. Priority changes on merged tickets use the existing ticket queue and resulting priority. The parent order is locked and its relevant references, including assigned organization, are rechecked before merging/creation.
- Assignees need an active exact company/tenant bridge, support.update and explicit organizational scope. Assignment persists the exact company membership. A suspended or conflicting assigned recipient makes user mutations fail transactionally; authorized unassignment remains possible. No first-membership or manager override fallback.
- Parent tickets are locked and reloaded under server scope. SQL updates retain the full ownership/object-scope predicate. History, content, ticket state, owned recipient notifications and domain outbox commit together. Failed transactions leave all of them unchanged. Raw child IDs in HTTP bodies are rejected; child lists are obtained only through an authorized parent. There are no separate support attachment/file/signing/storage HTTP operations or attachment model in the inspected support implementation; this does not certify unrelated upload endpoints.
- Explicit DTOs preserve existing list/detail envelopes and selected scalar fields. Messages/notes/events are bounded to 100/100/120; internal notes/events require support.assign or support.configure. Lists cap at 80; assignees and configuration directories cap at 200. Fresh reads replace the old support result cache, returning MISS. Scope denial sentinels, including nested order AND/OR, become valid empty UUID predicates, never global queries.
- SLA escalation and retention use fixed, narrow service operations against committed ticket ownership and persisted workflow timestamps. They reload active tenant/company, validate linked order ownership, lock each ticket, and conditionally transition it with transactional history/outbox. SLA recipients require the stored eligible company-membership bridge and explicit company support scope. Processing batches cap at 50. No initiating login is fabricated or required for maintenance of an accepted owned ticket. Concurrent duplicate escalation writes one transition/event/notification.
- Support source notifications require ticket tenant/owning company and the exact stored recipient membership, active support permission and explicit selected-company scope; queue-default user fallback is removed. Existing tenant-scoped notification reads/counts remain unchanged. Direct global support refresh is not published by these mutations; durable outbox remains the post-commit mechanism. Real Redis/outbox transport and notification delivery were not executed.

## Contained paths and compatibility

GET /support/stream returns 503: its old global SSE/replay bus cannot prove company/object ownership. No global subscription is opened. The legacy Redis/order-scanning support auto-triage worker is contained. Carrier failure, payment failure/webhook, label failure and generic rule/order alert helper contracts still return null without business writes: they pass caller-shaped references but no durable accepted source identity/capability. Canonical carrier code can have verified upstream acceptance; that evidence is not carried by this public support producer contract and is not invented here. Restoring each producer requires reloading its specific durable accepted source and defining an idempotent support operation. Platform-wide alert requirements need a separate design; no global notification exception was added.

Existing manual user operations continue only after tenant bridges/permissions/scopes are provisioned. Legacy unowned tickets are invisible and cannot be mutated. API ownership/company selector fields now reject rather than choosing a company; queue/rule callers must omit companyId and use the authenticated selection. Invalid status/priority is rejected rather than falling back to open/normal. Linked order creation requires shipment.view, customers.read where a customer master exists, and explicit warehouse access where a warehouse exists. Clients requesting hidden internal notes, global streams, historical tickets or unsupported assignment organizations need adjustment. No frontend/driver changes or browser/device compatibility claim. Bootstrap/configuration scripts were inspected but not executed; provisioning remains an explicit reviewed administrative activity.

Manual same-order merging is serialized under the order row lock. There is no new idempotency contract for repeated unlinked manual ticket creation. Existing workflow statuses/priority and server timestamps are retained; no general support lifecycle, cancellation, provider recovery or SLA policy redesign.

## Additive database boundaries

New migration: 20261001160000_support_ticket_ownership. Six Prisma models add two nullable ticket columns, back-relations, a tenant-leading ticket index and a company/queue compound unique target. Compound foreign keys enforce populated ticket tenant equality for owning/assigned organization, customer and warehouse; linked order must additionally have that owning company. The stored assignee membership binds user, tenant and company together. The CHECK requires owning company and either both or neither assignee bridge fields when tenant is populated.

Nullable expansion is transitional. A null ticket tenant bypasses tenant-compound foreign keys and the populated-context CHECK, including legacy partial assignee fields, but these rows are inaccessible through the new APIs. Null optional order/customer/warehouse/assigned organization/assignee/queue links omit their relationship checks; this is intentional optionality, not complete isolation. CustomerUserId/driverId legacy scalar links have no new compound membership FK; new creation validates them server-side, and old populated conflicting references are not certified. Same-tenant equality does not prove legal organizational classification or customer/order consistency. Active membership/tenant status and permissions remain application checks, not database constraints.

The company/queue FK is NOT VALID: new/changed references are checked, existing rows have not been certified. Existing tenant-null queue links can therefore prevent later unrelated updates if they conflict. No historical ownership was inferred or changed. The SQL CHECK and NOT VALID property are intentional SQL-only constraints; Prisma does not represent them. Original single-column relationships remain; this slice does not certify deletion/history behavior outside these support operations.

Offline Prisma validation establishes schema syntax/relations. Manual focused schema-to-SQL review checked the new columns, compound column order, targets, indexes, constraint actions and intentional SQL-only constraints. This is not a complete semantic schema/migration-drift certification. PostgreSQL execution below proves this migration chain and the tested constraints on synthetic disposable data, not deployed contents.

## Validation evidence

- `node node_modules/jest/bin/jest.js --runInBand tests/security/support-tenant-containment.test.ts tests/support/supportService.test.ts tests/security/support-http-containment.test.ts`: 43 passing cases (33 boundary/service cases, 3 summary/directory cases, 7 Fastify injection cases). Three subsequently added positive assignment/status/note, queue-creation and alternate-caller rejection cases passed separately with `--testNamePattern 'authorized assignment|authorized queue|alternate configuration'` (33 unchanged cases skipped). Total distinct support evidence is 46 cases, assembled across these runs, not a final full 46-case run. Mocked Prisma/identity snapshots and mocked ingress authentication; actual routes/service guards run. No claim of JWT, storage, Redis, provider or browser transport validation.
- `node node_modules/jest/bin/jest.js --runInBand tests/security/notification-tenant-containment.test.ts --testNamePattern 'support notification|support notifications'`: 3 passed, 7 unchanged cases skipped. Other notification behavior was not rerun.
- `node node_modules/prisma/build/index.js validate --config "$env:TEMP/cp-cash-prisma.config.ts"`: passed offline, using only absolute schema path; no dotenv/database endpoint/shadow database. Necessary client generation used that same isolated config and touched node_modules only, never dist. No dependencies changed.
- Disposable PostgreSQL: full 72 authored migrations applied, no db push/simplified schema. First successful run: 16 distinct cases passed. After scope/write corrections: 16 affected cases passed, 2 unchanged database-constraint cases skipped; this adds two new cases, for 18 distinct PostgreSQL cases overall. After the final assigned-organization recheck and nested denial normalization, `--testNamePattern 'linked order resolves|concurrent requests'` passed 2 cases with 16 unchanged cases skipped. These reruns are not added to the distinct-case count.
- Actual services, fresh database membership queries, transactions and transactional analytics outbox writes ran through Prisma PostgreSQL. Only the domain envelope builder was mocked to avoid Redis/logger initialization. Evidence covers populated compound constraint failures and unchanged rows, both tenant/company isolation, linked reference rejection, revoked context, removal of company scope, rollback of content/state/notifications/outbox, concurrent same-order merging, duplicate SLA processing, owned retention and suspended tenants. No exactly-once external delivery claim.
- Reused external disposable runner (not a repository deliverable): cached immutable PostgreSQL image, --pull never, unique run label/name/database marker, synthetic credentials, loopback random port, 512MiB memory/1 CPU/128 PIDs, exclusively owned 256MiB tmpfs and no bind/named volume. Isolated allowlisted environment excludes existing endpoints. Every successful run applies all 72 migrations before focused tests. Statement timeout 5s, connect timeout 3s, bounded pools and test deadline 120s.
- The first disposable attempt stopped before migrations because unix-socket readiness saw PostgreSQL's transient initialization server. The reused runner now checks TCP readiness. That failed attempt and all successful resources were ownership-verified and removed. No assertions weakened. PostgreSQL's historical overlong-index-name notices are pre-existing and were not repaired.
- Initial unit failures included a Proxy identity comparison; assertion was corrected to direct transaction-client identity, retaining ownership/outbox assertions. Type checking also caught dangling conditions after removal of obsolete route-only checks; corrected before final validation. These initial failures are not passing evidence.

- `node node_modules/typescript/bin/tsc --noEmit`: final pass after all source/test changes. No emitted build/dist writes.
- Final tracked/new-file whitespace and added-diff/new-file credential-marker checks passed. The 21-file support manifest was reviewed; support remains unstaged and uncommitted. No private files, dependency dumps, harness bundle or unrelated changes are included. No push or existing-service access.
- Disposable cleanup confirmed for initial failed readiness attempt and successful runs `cp-support-ownership-9b1d77749b89`, `cp-support-ownership-9017e4c6d581`, `cp-support-ownership-1b2992e9777e`; only run-owned container/tmpfs resources were removed.

## Remaining boundaries

No historical mapping, non-null ownership cutover, RLS, global support stream restoration, general notification transport redesign, platform alert exception, provider recovery or broader worker authorization. Fresh checks narrow cache delay but do not eliminate membership/permission revocation races between authorization and SQL execution; already queued external notifications need current delivery-side authorization. Stored ticket ownership is not an approved global service capability. Existing warehouse provisioning/assignment decisions, proof reconciliation and real-device/S3 verification, Redis lifecycle/backpressure, refresh-family concurrency, finance/payment/RBAC and all previous release gates remain open. No production-readiness or complete tenant-isolation claim.

## Exact changed-file manifest

- docs/security/Support_Tenant_Containment.md
- prisma/migrations/20261001160000_support_ticket_ownership/migration.sql
- prisma/models/customers.prisma
- prisma/models/identity-access.prisma
- prisma/models/orders.prisma
- prisma/models/organizations.prisma
- prisma/models/support.prisma
- prisma/models/tenancy.prisma
- src/modules/notifications-core/application/notificationService.ts
- src/modules/support-core/application/autoTriage.ts
- src/modules/support-core/application/supportAccess.ts
- src/modules/support-core/application/supportMaintenance.ts
- src/modules/support-core/application/supportRules.ts
- src/modules/support-core/application/supportService.ts
- src/modules/support-core/application/supportSlaMonitor.ts
- src/modules/support-core/transport/fastify-routes.ts
- tests/security/notification-tenant-containment.test.ts
- tests/security/support-http-containment.test.ts
- tests/security/support-tenant-containment.test.ts
- tests/security/support-tenant-postgres.integration.test.ts
- tests/support/supportService.test.ts

Checkpoint review: same exercised implementation/tests/schema/dependencies/configuration as recorded validation, inspected in place; unchanged evidence reused. Review-scope SHA256 (20 implementation/test/schema files plus package.json/package-lock.json/jest.config.js/tsconfig.json; LF normalized): 6066e679fe4e7361e0dfac85de87436c35cde39946ac3bdb59799793313af23d. Historical validation wording above describes the pre-checkpoint state. No independent-review claim.
