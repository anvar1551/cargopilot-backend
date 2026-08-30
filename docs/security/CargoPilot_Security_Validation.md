# CargoPilot Backend Security Validation

## 1. Validation scope

- Validation date: 2026-08-30
- Current committed baseline: `da64d765ff01d1c3cfde58d12ddd1042535f47b5`
- Baseline branch: `cargopilot/erp-foundation`
- Original review snapshot: `46455c379c5315411671e465bab091d2ad61f9ac`
- Original review: `docs/security/CargoPilot_Backend_Security_Review.md`
- Method: static review of committed `HEAD`, focused synthetic unit tests, and repository configuration review.
- Excluded: production database access, AWS inspection, deployment mutation, credential use, and production migrations.

The working tree was already dirty before this validation. Existing uncommitted finance, Redis, deployment, generated `dist`, Prisma split-schema, test, and migration changes were not reverted or treated as part of the committed baseline. Evidence below therefore refers to `git show HEAD:<path>` unless stated otherwise.

## 2. AGENTS.md validation

The complete root `AGENTS.md` was reviewed against the current repository structure, package scripts, Prisma layout, application modules, workers, tests, Docker files, and documentation.

Result: no factual path or command correction is required.

- The file contains policy and safety rules rather than stale concrete `src/services/*` references.
- Its instruction to run applicable build, test, lint, migration, and integration checks is accurate. This repository has build and test scripts but no lint script, and the word `applicable` preserves that distinction.
- Its multi-company ERP, tenant-isolation, migration-safety, transaction, test, and production-safety rules match the intended architecture and must not be weakened.
- The root `AGENTS.md` is present in the worktree but is not tracked by committed `HEAD`; this is a repository-governance decision, not a content defect.

## 3. Current architecture and trust boundaries

The current backend is no longer the legacy single-role snapshot reviewed in August. It now has `Organization`, `CompanyMembership`, multi-role membership bindings, permissions, membership scopes, payment intents, integration providers, outboxes, workers, support automation, Redis/SSE, and organization-scoped order fields.

It is still not a consistently isolated multi-company ERP:

- `Organization` and `CompanyMembership` establish an identity foundation.
- `Order.ownerOrgId` and `Order.assignedOrgId` are optional.
- `Warehouse`, `CustomerEntity`, and `Address` have no mandatory tenant/company ownership.
- `MembershipScope.scopeRefId` is an unvalidated generic UUID without a foreign key to the scoped object.
- Several authorization paths use company membership, while several business repositories remain global.
- No PostgreSQL row-level security or tenant-matching composite foreign keys exist.

The practical model is therefore a partially migrated logistics operator with company-aware modules, not yet a provably isolated independent-company platform.

Primary trust boundaries:

1. Browser/mobile client to Fastify routes.
2. JWT to current membership/permission snapshot.
3. Membership and generic scopes to business-object queries.
4. API/worker processes to PostgreSQL and Redis.
5. Payments and integrations to external provider APIs and inbound webhooks.
6. Proof, label, invoice, and attachment flows to S3 or local volumes.
7. Analytics, caches, SSE, Socket.IO, and workers to derived or asynchronous data.

## 4. Findings summary

| Status | Finding IDs |
|---|---|
| Confirmed | 01, 02, 03, 04, 07, 09, 10, 11, 12, 14, 20, 21, 22, 23, 24, 26, 31, 32 |
| Partially Confirmed | 05, 06, 08, 13, 15, 18, 25, 27, 29 |
| Fixed Already | 17 |
| Requires Runtime Test | 16, 19 |
| Requires Infrastructure Verification | 28, 30 |
| False Positive | None |

Passing tests do not alter these statuses where the relevant tenant, authorization, lifecycle, or concurrency behavior is not covered.

## 5. Validated findings

| ID | Status, severity, prerequisites | Current evidence and affected data/action | Remediation and required regression test | Schema/API impact |
|---|---|---|---|---|
| 01 | **Confirmed - P0.** Requires an authenticated actor with a broadly useful permission or a path that accepts an object ID. | `prisma/schema.prisma`: `CompanyMembership` exists, but `Warehouse` and `CustomerEntity` have no tenant key; `Order.ownerOrgId` is nullable; `MembershipScope.scopeRefId` is an unconstrained UUID. End-to-end ownership cannot be enforced for users, warehouses, customers, addresses, orders, files, jobs, or derived data. | Introduce an approved tenant root and mandatory tenant keys, quarantine unmapped records, and reject missing or mismatched scope. Test tenant A/B list, detail, mutation, file, queue, analytics, and event isolation. | Major schema migration; additive then breaking API behavior where tenant context becomes mandatory. |
| 02 | **Confirmed - P0/High.** Requires `customers.read`. | `buildCustomerEntityScopeWhere()` in `src/modules/identity-access/access-control.ts` returns `null` for company-scoped customer permissions. `customers-core/transport/fastify-routes.ts` therefore lists the global directory. Detail loads by ID first and only evaluates a simple `scopeWhere.id`, ignoring relational scope predicates. Names, email, phone, tax data, addresses, and counts may cross companies. | Add mandatory tenant ownership to customer records and apply the complete scoped predicate in both list and detail queries before retrieval. Test customer A/B and company employee A/B positive and negative cases. | Schema change required for reliable fix; detail/list response behavior changes. |
| 03 | **Confirmed - P0.** Requires `shipment.create`; target customer UUID must be known or guessed. | `createOrderForActor()` in `src/modules/orders-core/write/create-order.ts` preserves request `customerEntityId` before falling back to the actor. CSV preview/confirm accept the same ID. `createOrder()` only verifies existence. Orders and saved addresses can be attached to another customer record. | Resolve permitted customer ownership from the authenticated membership. Require an explicit on-behalf-of permission and same-tenant lookup for admin creation and imports. Test cross-company customer IDs before any write or side effect. | Tenant key schema needed for complete fix; request may retain `customerEntityId` but authorization semantics change. |
| 04 | **Confirmed - P0/High.** Requires `shipment.create` and a foreign address UUID. | `mapCreateOrderDtoToRepoPayload()` scopes sender lookup to caller-supplied customer ID but loads receiver with `findUnique({id})`. `assertFkExistsTx()` in `order-write.repo.ts` checks only existence for both IDs. Foreign address contents can be reused through an order. | Query addresses by tenant plus permitted customer and enforce tenant-matching foreign keys. Test sender and receiver IDs from tenant B against tenant A. | Schema and foreign-key changes; existing request shape can remain. |
| 05 | **Partially Confirmed - P0/High.** Requires `shipment.view` or another order permission. | Order labels, tracking, and detail now generally use `buildOrderScopeWhere()`, improving the old inconsistency. However `warehouseRepo.listWarehouses()` is global and `getWarehouseById()` accepts arbitrary IDs. Warehouse ownership itself is absent. Workload authorization remains broad. | Use one tenant-first resource policy for every representation and workload query; scope warehouses themselves. Test the same foreign order through detail, label, tracking, proof, cash, workload, and warehouse APIs. | Warehouse tenant schema required; some list/detail behavior changes. |
| 06 | **Partially Confirmed - P0/High.** Requires a malformed/legacy identity or a company-scoped permission. | `buildOrderScopeWhere()` fails closed when no clauses exist, and live-map policy rejects warehouse events when the actor has no warehouse. Conversely, `buildCustomerEntityScopeWhere()` deliberately returns `null` for company scope, which becomes global because customer records have no tenant key. Generic scope IDs are not ownership-validated. | Make missing context deny access; distinguish explicit platform override from ordinary company scope; validate every scope reference. Test null, omitted, stale, and foreign scopes. | Scope validation may require schema constraints and API errors for formerly accepted data. |
| 07 | **Confirmed - P0/High.** Requires `shipment.view` and a warehouse ID. | `getWarehouseById()` in `warehouse-core/application/warehouseRepo.ts` uses `include: { users: true, orders: true }`. Prisma serializes persisted `User.password`; the route returns the object unchanged and has no object scope. Password hashes and unrelated order data can be exposed. | Replace includes with explicit safe projections and scope the warehouse query. Add recursive response tests rejecting password, token hash, encrypted secret, and recovery fields. | No schema change; response fields become safer and narrower. |
| 08 | **Partially Confirmed - P0/High.** Requires user/role administration permissions. | Legacy hardcoded manager checks were replaced by memberships and permissions. However `resolveRoleIdsForCompany()` permits system roles, no grant ceiling is enforced, `createUserByCompanyAdmin()` accepts arbitrary warehouse/customer/scope UUIDs, and those scope references are not verified as belonging to the company. | Enforce grant ceilings, separate platform and tenant administration, validate target membership and every scope object, and audit grants/overrides. Test that tenant admins cannot assign system/platform roles or tenant-B scopes. | Likely permission-policy and audit schema changes; role-management API may reject existing payloads. |
| 09 | **Confirmed - P0/High.** Requires analytics/live-map access under different companies. | `analytics-core/infrastructure/makeScopeKey.ts` keys manager data globally and only specializes warehouse scope. `analytics-core/transport/fastify-routes.ts` emits `tenantScope: "role:manager"`. Live-map cache keys use role/warehouse rather than company membership. Socket.IO derives roles from all active memberships and joins role rooms. | Include tenant ID, membership authorization version, and object scope in cache keys, computations, invalidations, rooms, jobs, and downloads. Reauthorize long-lived subscriptions. Test warmed tenant-A caches/events against tenant B. | Cache/event contracts change; no mandatory DB change beyond the tenant model. |
| 10 | **Confirmed - P0.** Requires any missed application filter or compromised application query path. | No RLS policies, mandatory tenant keys, or tenant-matching composite foreign keys exist in committed schema/migrations. Application queries alone carry the isolation burden. | After model approval, add mandatory tenant keys, composite uniqueness/FKs, and transaction-safe PostgreSQL RLS or an equivalent enforced isolation strategy. Test using the application DB role directly. | Major schema and deployment-role migration. |
| 11 | **Confirmed - P0/Financial.** Requires `shipment.create` or CSV import. | `orderCreate.mapper.ts` accepts `codPaidStatus`, `serviceChargePaidStatus`, and `serviceCharge`; `order-write.repo.ts` persists them; `cash/collection.shared.ts` suppresses expected collections when the client says `PAID`; CSV exposes the same fields. | Remove authoritative paid status from customer/order-create inputs. Only verified provider events or privileged audited reconciliation may change it. Test that client flags cannot suppress an obligation. | API fields must be removed/ignored or split into non-authoritative instructions; no tenant schema dependency. |
| 12 | **Confirmed - P0/Financial.** Requires `payments.intents.create`. | Order creation now derives the payable amount from pricing components, which fixes the old direct path. However `POST /payments/intents` accepts `amountMinor` and `currency`, and `createPaymentIntentForActor()` only checks that the order exists, not that it belongs to the company or that amount/currency match authoritative pricing. A caller can initiate a mismatched checkout. | Make payment intent creation internal or derive order/company/amount/currency from a stored quote and order. Test changed amount, currency, company, and foreign order IDs. | Public payment-intent API semantics change; no mandatory schema change if stored pricing is authoritative. |
| 13 | **Partially Confirmed - P1/Financial integrity.** Requires boundary amounts or multi-currency flows. | `PaymentIntent` and payment ledger use integer minor units, while `Order.codAmount`, `Order.serviceCharge`, and cash collection amounts remain `Float`. Legacy `invoiceRepo.ts` hardcodes Stripe currency to EUR. Mixed representations can drift. | Standardize exact decimals/minor units with explicit supported currency exponents; remove or rewrite the legacy invoice path. Test rounding boundaries and UZS/USD/CNY end to end. | Monetary schema migration and serialized amount compatibility plan required. |
| 14 | **Confirmed - P1/High.** Requires provider/label/pricing failure or request retry. | `createOrderForActor()` commits the order before pricing-component seed, carrier auto-book, label work, and payment validation/intent creation. CSV imports loop sequentially without a durable batch key/checkpoint. Proof S3 uploads precede the DB transaction, with only best-effort cleanup. | Validate/authorize first, add tenant-scoped idempotency and durable outboxes/checkpoints, and reconcile orphaned objects. Test injected failure at every boundary and request replay. | Idempotency fields/jobs may require schema and response-state additions. |
| 15 | **Partially Confirmed - P1/Financial.** Requires a valid but duplicate, unexpected, or mismatched provider event. | Stripe raw-body signatures and provider event IDs are verified; `PaymentWebhookEvent.upsert()` provides atomic deduplication. The canonical transition does not compare webhook amount/currency/status binding to stored intent values before updating the order and cash state. Full request headers are also stored. | Reconcile provider object, amount, currency, company, intent, and allowed transition; redact headers; process documents asynchronously. Test duplicate/concurrent and mismatched signed events. | Usually no public API change; webhook/audit schema may gain normalized reconciliation fields. |
| 16 | **Requires Runtime Test - P1.** Requires simultaneous conflicting collect/handoff/settle operations. | `orders-core/cash/collection.service.ts` reads collection state and later updates by ID inside a default Prisma transaction. There is no state/version predicate, row lock, or serializable retry. The source pattern is unsafe, but the exact PostgreSQL interleaving was not executed. | Add optimistic version/state predicates or row locks/serializable retries plus operation IDs. Run a real local PostgreSQL concurrency test asserting one legal transition and consistent events. | Likely version/operation-key schema addition; conflict responses may become `409`. |
| 17 | **Fixed Already - P1 originally.** Requires a stolen refresh token and password change. | `changeUserPassword()` in `identity-access/application/auth.service.ts` updates the password and revokes every active `UserRefreshSession`. | Keep regression coverage proving old refresh tokens fail. Add access-token/session-version revocation if a shorter compromise-recovery window is required. | Current fix has no API/schema change; stronger access revocation may add an auth version. |
| 18 | **Partially Confirmed - P1.** Requires role/membership revocation while tokens or sockets remain active. | HTTP auth now reloads `loadAccessSnapshot()` and rejects inactive memberships, fixing the old claim-only path. Socket.IO accepts access tokens with optional `tokenType`, aggregates roles across every active membership, and does not disconnect on expiry or membership changes. | Bind sockets to one membership/company, require access token type, track expiry/session version, and disconnect on revocation. Test role removal and company switch during SSE/Socket.IO sessions. | Realtime authentication contract changes; session/auth version may require schema. |
| 19 | **Requires Runtime Test - P1.** Requires concurrent refresh/reuse/logout calls. | `refreshUserSession()` reads an active session, then performs an unconditional `update({id})` outside a consume-if-active transaction before issuing a replacement. Revoked rows remain, but token-family/replacement history and reuse detection are absent. | Atomically consume `revokedAt:null`, retain family/replacement history, detect reuse, and revoke the family. Run deterministic concurrent refresh/refresh and refresh/logout tests. | Refresh-session schema expansion and token lifecycle behavior change. |
| 20 | **Confirmed - P1.** Requires a token issued with a related secret or cross-application/environment token. | Access and refresh signing/verification omit issuer, audience, subject policy, and explicit algorithm allowlists. HTTP requires access `tokenType`; Socket.IO accepts it when absent. Default access TTL is 12 hours. | Require issuer, audience, algorithm, purpose, expiry, subject, membership/company, and key identifier; document key rotation. Test wrong app/environment/type/algorithm and expired tokens. | Token format and all clients change; may add key/session version fields. |
| 21 | **Confirmed - P0/Critical.** No authentication is required for exploitation. | `POST /register` is public and forwards caller-supplied `companyId` and `roleCodes`. `registerUser()` resolves company or system roles and creates an active company membership plus company scope. Password minimum is six characters and no route-level rate limiter is installed. This can become direct privileged role enrollment if privileged role codes are known/configured. | Disable arbitrary public role/company selection. Use verified invitation tokens with fixed company/role ceilings, stronger password policy, throttling, email verification, recovery, suspension, and MFA for privileged accounts. Test attempts to register system/admin roles and another company. | Registration API must change; invitation/account lifecycle schema likely required. |
| 22 | **Confirmed - P1/High.** Requires an assigned driver and proof submission. | `submitProofForActor()` trusts client MIME/extension for the photo and stores a client-provided string whenever it starts with `<svg`. The SVG is later served as `image/svg+xml`. No image decoding/re-encoding or SVG sanitization occurs. | Accept strict raster formats, decode and re-encode server-side, generate signature SVG only from bounded numeric paths, and serve attachments with safe content disposition. Test polyglots, active SVG, oversized dimensions, and MIME mismatch. | Proof request should drop `signatureSvg`; response/API behavior changes slightly. |
| 23 | **Confirmed - P1/Integrity.** Requires an assigned driver and proof submission. | `parseDateOrNow(body.savedAt)` accepts a client timestamp, and `submitProofForActor()` writes it as the authoritative tracking timestamp. | Store server receipt time as authoritative; preserve device time separately with accuracy/skew metadata. Test past/future timestamps and offline uploads. | Tracking/proof schema may add device-captured time; request field semantics change. |
| 24 | **Confirmed - P1.** Requires export permission and attacker-controlled spreadsheet text. | `csvEscape()` only quotes values and doubles quotes. It does not neutralize cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return. Customer/order fields can become formulas when opened in spreadsheet software. | Prefix dangerous cells with an apostrophe or use a safe CSV library/policy. Test every dangerous prefix and ordinary text. | CSV output changes; no schema change. |
| 25 | **Partially Confirmed - P1.** Requires large authenticated requests or expensive filters. | Fastify has a 5 MiB body cap, proof multipart has a file-size cap, bulk order IDs default to 100, list limits are bounded, and exports are capped. CSV imports have no row cap/checkpoint, parcel arrays and many strings lack practical maxima, and some expensive endpoints have no request budget. | Add per-operation row/item/string limits, import jobs/checkpoints, timeouts, and cost-aware query limits. Test exact boundary and over-limit cases. | Validation errors and optional async import API; no mandatory tenant schema change. |
| 26 | **Confirmed - P1/High availability and abuse.** Requires network access to public routes. | `.env.example` documents rate-limit variables, but `package.json` has no `@fastify/rate-limit` and startup registers no limiter. Login, registration, webhooks, exports, analytics, and telemetry rely on no integrated HTTP rate limiting. Webhook signatures exist but do not replace abuse controls. | Install an approved limiter only after owner approval, use fail-closed or bounded local fallback policy, provider-aware webhook limits, and account/source controls. Test Redis failure and burst behavior. | Runtime dependency/config and `429` behavior change; no schema required unless counters/audit are persisted. |
| 27 | **Partially Confirmed - P1.** Requires worker crash after claiming a job or persistent failures. | Label claims use compare-and-swap on attempts/status and bounded retries, improving the old queue. The worker only claims `pending`/`failed`; a crashed `processing` job is not reclaimed by the worker. API auto-fallback can handle stale work only when scheduled in that process. | Add deterministic stale-lock recovery to the worker, dead-letter visibility, idempotent object writes, and fair retry ordering. Test crash-after-claim and old failed-job starvation. | No public API change; job status/lease fields may be extended. |
| 28 | **Requires Infrastructure Verification - P0 if exposed.** Requires network reachability or weak database credentials. | Compose now binds API, PostgreSQL, and Redis to `127.0.0.1` by default, improving the archived configuration. PostgreSQL still defaults to password `cargopilot`; Redis has no authentication/TLS in compose. Security groups, host firewall, and deployed overrides cannot be proven from the repository. | Remove weak production defaults, use secret-managed credentials, private networking, Redis ACL/TLS as applicable, and verify listening sockets/security groups. Test unauthenticated access from an external host. | Deployment/config change; database credential rotation outside this validation. |
| 29 | **Partially Confirmed - P1/Medium.** Requires missing/misconfigured origin and proxy environment. | `src/index.ts` allows any origin when the configured origin set is empty while credentials are enabled. `TRUST_PROXY` defaults to true. Correct production environment may mitigate both, but code defaults fail open. | Fail startup in production when origins are empty, parse explicit trusted proxy CIDRs/hops, and test hostile Origin and spoofed forwarding headers. | Configuration behavior changes; no schema/API contract change. |
| 30 | **Requires Infrastructure Verification - P1/High.** Requires compromised runtime or overprivileged cloud/database credentials. | The container runs as non-root, which is good. `src/config/s3.ts` forces static AWS access-key environment variables instead of the SDK default credential chain. The API entrypoint runs `prisma migrate deploy` by default, so the runtime role may also hold DDL rights. IAM, bucket policy, DB grants, and secret storage are not visible. | Use workload identity/instance roles, separate migration and runtime DB roles, least-privilege buckets/prefixes, and secret manager injection. Verify IAM and DB grants outside the repository. | Deployment and credential model change; no public API change. |
| 31 | **Confirmed - P1/High control gap.** Requires privileged/admin actions or incident investigation. | Permission `audit.read` exists, but committed schema has no comprehensive immutable IAM/security audit trail. Role/scope changes and `policy.override` use are not consistently recorded. Payment/integration webhook tables persist complete headers, which may retain Authorization/cookie/API-key material. Error logging is inconsistent. | Add structured append-only security audit events, actor/company/object/request IDs, redaction allowlists, override justification, retention, and export controls. Test audit creation and secret redaction. | Audit schema and admin API additions; log format changes. |
| 32 | **Confirmed - P2 assurance gap.** Requires a vulnerable change reaching release. | CI only installs, compiles, and builds/pushes a Docker image. It does not run Jest, tenant-negative tests, dependency audit, secret scan, SAST, migration validation, container scan, SBOM, or provenance/signing. Existing tests contain no comprehensive tenant A/B authorization matrix. | Add staged release gates, synthetic tenant tests, dependency/secret/SAST/container scanning, migration checks, SBOM, image signing/provenance, and rollback evidence. | CI/release process change; no product API/schema change. |

## 6. Additional current-HEAD defects

These are current defects discovered while validating the original hypotheses. They should be tracked even though they do not have separate IDs in the archived report.

### A. Public registration role and company escalation

This is the strongest current release blocker and is included under finding 21. An unauthenticated caller can submit `companyId` and `roleCodes`; system roles are eligible in `resolveRoleIdsForCompany()`. Public registration must not be exposed in this form.

### B. Arbitrary membership scope references

`createUserByCompanyAdmin()` and `updateUserAccessByCompanyAdmin()` accept warehouse, customer, branch, and generic scope UUIDs without validating type, company ownership, or hierarchy. `MembershipScope.scopeRefId` has no foreign key. A tenant administrator can inject a foreign scope if an ID is known.

### C. Integration-provider SSRF

`integrationHttpJson()` in `integrations-core/application/integration-http-client.ts` validates only the `http:`/`https:` scheme. Admin-configured provider URLs can target loopback, RFC1918, link-local/cloud metadata, or DNS-rebinding destinations; redirects are not constrained. Restrict approved endpoints, resolve and validate every connection target/redirect, and block private/special-use networks unless explicitly allowlisted.

### D. Sensitive webhook-header retention

Payment and integration webhook handlers persist full request headers in JSON. This can retain Basic authorization, cookies, API keys, or provider signatures. Store an allowlisted/redacted subset plus a body hash and verification metadata.

## 7. Tests and tool results

Focused safe command:

```powershell
$env:DATABASE_URL='postgresql://test:test@127.0.0.1:5432/test'
npm test -- --runInBand `
  tests/integrations/hmac-webhook.verifier.test.ts `
  tests/integrations/integration-secret.crypto.test.ts `
  tests/integrations/outbox-dispatcher.test.ts `
  tests/integrations/provider-adapters.test.ts `
  tests/live-map/liveMapEventPolicy.test.ts `
  tests/s3Cleanup.test.ts
```

Result: 6 suites and 21 tests reported passing. Jest retained an open handle and the 120-second command wrapper timed out after the successful result was printed. This is a test-harness cleanup issue and not evidence that tenant or financial controls are safe.

`npm audit --omit=dev --json` did not return before the 90-second safe timeout. Dependency vulnerability status therefore remains unverified and must be rerun from a network with reliable npm advisory access.

No production services or configured credentials were used.

## 8. Proven defects, conditional risks, and unknowns

### Proven source-code defects

- Global or incomplete customer/warehouse ownership checks.
- Password hash serialization from warehouse detail.
- Caller-selected customer/address ownership in order creation and import.
- Caller-selected paid states and generic payment intent amount/currency.
- Public registration accepts company and role selection.
- Unvalidated generic membership scope references.
- Global analytics/cache scope behavior.
- Unsafe proof SVG/MIME handling and client-authoritative timestamps.
- CSV formula injection.
- Missing HTTP rate limiting.
- Integration SSRF and sensitive webhook-header retention.

### Findings supported by existing tests

- HMAC signature verification and timestamp rejection.
- Integration secret encryption/wrong-key behavior.
- Integration dispatcher behavior covered by existing synthetic tests.
- Provider adapter mapping covered by existing synthetic tests.
- Live-map event filtering for tested warehouse cases.
- S3 cleanup key normalization.

These tests do not cover comprehensive tenant A/B isolation.

### Conditional configuration risks

- CORS is permissive when production origins are empty.
- Proxy trust defaults to enabled.
- Redis behavior and rate-limit variables do not provide HTTP rate limiting by themselves.
- Weak compose database defaults become dangerous if used outside isolated development.

### Infrastructure facts not verified

- AWS IAM roles, bucket policy, encryption, public access block, lifecycle, and access logs.
- Host firewall, Lightsail/AWS security groups, TLS termination, proxy headers, and listening ports.
- Production PostgreSQL roles, RLS, backups, PITR, encryption, and network exposure.
- Redis ACL/TLS/network exposure and persistence policy.
- Production secret storage, rotation, image provenance, monitoring, and incident response.

### General enterprise hardening recommendations

- MFA and verified invitation lifecycle for privileged users.
- Centralized security audit and SIEM export.
- Formal key rotation and break-glass process.
- SBOM, image signing, provenance, secret scanning, SAST/DAST, and periodic penetration testing.
- Backup restoration drills and disaster-recovery objectives.

## 9. Immediate fixes completed in this validation pass

No application-code fix was applied in this pass. The purpose was to establish a reliable current-HEAD baseline without mixing security fixes into the already dirty worktree.

Documentation changes only:

- Restored the supplied review unchanged at `docs/security/CargoPilot_Backend_Security_Review.md`.
- Added this current-HEAD validation at `docs/security/CargoPilot_Security_Validation.md`.
- Left `AGENTS.md` unchanged because no factual path/command correction was required.

The next implementation pass should start with non-structural release blockers 07, 11, 12, 21, 22, 23, 24, 26, and the header-redaction/SSRF defects, while designing 01-10 as one coherent tenant migration rather than scattered filters.

## 10. Proposed tenant data model for owner approval

Do not implement this migration until real/demo data status and business semantics are confirmed.

### Tenant

- `Tenant(id, code, legalName, status, createdAt, updatedAt)`
- One independent CargoPilot customer/company security boundary.
- The existing top-level `Organization(type=company)` can either be migrated into `Tenant` or retained as its root `CompanyUnit`; this requires an owner decision.

### TenantMembership

- `TenantMembership(id, tenantId, userId, status, authzVersion, createdAt, updatedAt)`
- Unique `(tenantId, userId)`.
- Roles and scope bindings reference this membership.
- Suspension and authorization-version changes invalidate tokens, caches, and live sessions.

### CompanyUnit

- `CompanyUnit(id, tenantId, parentUnitId, type, code, name, status)`
- Represents branch, agent, pickup point, carrier unit, or other organization hierarchy.
- Unique `(tenantId, id)` and `(tenantId, code)` as appropriate.
- Parent references must include the same `tenantId`.

### Warehouse

- Add mandatory `tenantId` and optional/required `companyUnitId` according to the business rule.
- All warehouse access, driver access, order current-warehouse, cash holder, tracking, and leg references include/validate `tenantId`.

### CustomerEntity

- Add mandatory `tenantId`; this remains business master data, not identity or tenant.
- Users may link to a customer entity only within their active tenant membership.
- Shared global customers, if genuinely required, need an explicit separate global master plus tenant-specific account relationship, not a nullable tenant key.

### Other mandatory ownership

- `Order`, `Address`, `Parcel`, `Tracking`, proof/attachment/document, label job, invoice, payment intent/event/ledger, cash collection/event, support ticket, integration provider/outbox/event, pricing rule/tariff, analytics outbox/read model, and notification records need explicit tenant derivation and constraints.
- Prefer composite foreign keys containing `tenantId` for business relationships.
- Evaluate PostgreSQL RLS only with a safe transaction-scoped tenant context compatible with Prisma pooling.

## 11. Migration strategy

1. Inventory every existing record and classify it as mapped, ambiguous, global reference data, or orphaned.
2. Create tenant/unit/membership tables and nullable tenant columns additively.
3. Backfill only from deterministic evidence such as existing company membership and `ownerOrgId`.
4. Place ambiguous records in a quarantine report/table; never assign them to the current caller or first company.
5. Add duplicate tenant-aware indexes and foreign keys in a non-breaking phase.
6. Deploy dual-read validation and metrics without broadening access.
7. Backfill dependent files, jobs, caches, events, and integration records.
8. Reject new tenant-null business writes.
9. Validate counts, orphan checks, cross-tenant joins, and rollback procedure.
10. Make tenant columns non-null and switch to composite constraints/RLS only after approval and rehearsed restoration.

## 12. API and frontend compatibility impact

- Tokens must bind one active tenant membership and carry/resolve an authorization version.
- Company/tenant context may become explicit in invitation, company-switch, and platform-admin flows.
- Customer, warehouse, order, payment, integration, and support IDs remain opaque UUIDs but foreign-tenant IDs return `404` or `403` consistently.
- Public registration must become invitation or self-service customer registration with fixed role/company policy.
- Payment intent amount/currency and paid-state inputs become server-owned.
- Proof upload fields and CSV output behavior change for security.
- Frontend selectors must load only tenant-scoped objects and stop sending authoritative finance fields.

## 13. Owner decisions required before structural migration

1. Is one top-level `Organization(type=company)` exactly one independent tenant, or can one tenant own several legal companies?
2. Can a user belong to multiple tenants, and how is the active tenant selected?
3. Are any customers legitimately shared across tenants, or must all customer master records be private?
4. Can warehouses serve multiple tenants, or must each warehouse have one tenant owner?
5. Which existing deployed/demo records are real and must be preserved?
6. Which roles may a tenant administrator grant, and which remain platform-only?
7. Should public self-registration exist at all; if yes, which fixed customer role/company policy applies?
8. What token/session revocation window is required for privileged accounts?
9. Which proof file types and offline timestamp behavior are contractually required?
10. Is PostgreSQL RLS required for the first production release or scheduled after mandatory tenant keys/composite constraints?

## 14. Verification commands

Run from the repository root using only a local/synthetic database:

```powershell
git status --short
git rev-parse HEAD
npm ci
npm run build
npm test -- --runInBand
npx prisma validate
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npm audit --omit=dev
docker compose --env-file .env.docker config
docker build --target prod -t cargopilot-backend:security-validation .
```

Future tenant tests must use tenant A, tenant B, two warehouses, customer/warehouse/driver/admin actors, known foreign IDs, positive access cases, and negative list/detail/mutation/file/event cases.

