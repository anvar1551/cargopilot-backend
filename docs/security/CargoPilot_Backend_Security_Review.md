# CargoPilot backend: multi-company security review

Review date: 28 August 2026. Scope: the uploaded `cargopilot-backend-main.zip`, snapshot identified by archive comment as `46455c379c5315411671e465bab091d2ad61f9ac`.

## Executive decision

**Do not treat this snapshot as ready to hold confidential data for multiple independent companies.** The application has authentication, role checks and some object-level authorization, but it does not consistently enforce the company boundary described by its owner.

The main architectural distinction is: a business customer record is not a security tenant. `CustomerEntity` represents a person or customer company. It does not own warehouses or scope all employee accounts. `Warehouse` has no owning tenant; `User` has one global role; managers can operate globally. That resembles one logistics operator serving many customers, not separate companies each owning their own isolated ERP environment.

This is a source review and limited isolated testing, **not an exhaustive penetration test, a production audit, or certification of equivalence to SAP**. The 32 entries below include overlapping implementation flaws, conditional risks and enterprise control gaps; they are not 32 independently proven exploits.

No production endpoint, AWS account, real database or real customer record was accessed. The backend source was not changed. Dependency installation, application startup and database-connected test suites were deliberately not run.

## Evidence and severity

- **Code:** the relevant implementation was inspected; production behavior has not been verified.
- **Mock:** original source functions were executed with fake persistence/external services. This verifies local control flow, not a complete HTTP/database integration.
- **Conditional:** impact depends on configuration, existing data, concurrency or how the frontend displays content.
- **Gap:** a required enterprise control was not found in the supplied source; it could exist elsewhere.
- **P0:** block real multi-company rollout until addressed. **P1:** complete before a controlled production pilot. **P2:** hardening and assurance work before claiming enterprise readiness.

Severity is contextual rather than a CVSS score. Critical assumes mutually untrusted companies share this deployment. A missing control is not automatically evidence of a successful attack.

## Issue register

| ID | Priority / severity | Finding | Evidence status |
|---|---|---|---|
| 01 | P0 / Critical | No enforceable company/tenant ownership model | Code, gap |
| 02 | P0 / High | Customers can list and read unrelated customer entities | Code, mock |
| 03 | P0 / High | Order creation and CSV import accept caller-selected company ownership | Code, creation mock |
| 04 | P0 / High | Address IDs are resolved without authenticated ownership checks | Code |
| 05 | P0 / High | Warehouse authorization differs across order-related endpoints | Code, mock |
| 06 | P0 / High | Missing organization scope can broaden access instead of denying it | Code, conditional mock |
| 07 | P0 / High | Warehouse detail can serialize user password hashes | Code, mock |
| 08 | P0 / High | Global manager powers and inadequate administrative separation | Code, gap |
| 09 | P0 / High | Reports, caches and event streams lack a tenant boundary | Code, gap |
| 10 | P0 / High | No database-enforced tenant references or isolation layer | Code, gap |
| 11 | P0 / High | Customers can supply payment-completion flags | Code, cash-seeding mock |
| 12 | P0 / High | Checkout amount is supplied by the client | Code, mock; payments enabled |
| 13 | P1 / Medium | Financial precision and currency consistency weaknesses | Code |
| 14 | P1 / High | Order/payment/import workflow has partial-write and retry hazards | Code, partial-write mock |
| 15 | P1 / Medium | Webhook reconciliation and duplicate processing are incomplete | Code; concurrency untested |
| 16 | P1 / Medium | Cash state checks and writes need concurrency protection | Code, conditional |
| 17 | P0 / High | Password changes do not revoke refresh sessions | Code, mock |
| 18 | P1 / High | Stale privileges and long-lived connections survive account changes | Code, mock / conditional |
| 19 | P1 / Medium | Refresh rotation lacks an atomic active-session condition and reuse history | Code, conditional |
| 20 | P1 / Medium | JWT acceptance policy is under-specified | Code, gap |
| 21 | P1 / Medium | Authentication and account-lifecycle safeguards are incomplete | Code, gap |
| 22 | P1 / High | Uploaded proof content can contain active or unexpected file types | Code; browser impact conditional |
| 23 | P1 / Medium | Client timestamps are used as proof-event timestamps | Code |
| 24 | P1 / Medium | CSV exports do not neutralize spreadsheet formulas | Code; spreadsheet behavior conditional |
| 25 | P1 / Medium | Insufficient per-user/tenant limits on expensive work | Code, gap |
| 26 | P1 / Medium | Rate limiting fails open on store errors; webhook bypasses global limiter | Code, conditional |
| 27 | P1 / Medium | Label queue can strand or starve work | Code; failure scenarios untested |
| 28 | P0 / High if reachable | Deployment defaults publish database/Redis ports and use weak defaults | Code; AWS exposure unknown |
| 29 | P1 / Medium | Permissive CORS fallback and fixed proxy trust need production validation | Code, conditional |
| 30 | P1 / Medium | Static AWS credentials and shared runtime/migration privilege assumptions | Code, deployment unknown |
| 31 | P1 / High control gap | Security auditing, sensitive-data minimization and error handling need work | Code, gap |
| 32 | P2 / Assurance gap | No demonstrated security release gates or production assurance | Code, unknowns |

### 01 — Tenant ownership is missing

Evidence: [Prisma schema][schema], especially `User`, `Warehouse`, `CustomerEntity`, `Order` and `DriverWarehouseAccess`. User creation links `CustomerEntity` only for customer-role accounts. A manager, driver or warehouse operator has no mandatory company membership.

Impact: the backend cannot consistently express “company A owns this warehouse, these employees and these records.” UUIDs and role enums do not supply that missing boundary.

Fix: introduce `Tenant`, active `TenantMembership`, tenant-scoped role grants, and mandatory tenant ownership on business records. Keep customer master data separate from tenant identity. Quarantine unmapped historical records during migration; never assign them to the current caller by default.

Acceptance: a tenant-A manager must not access tenant-B records, including through joins, exports, files, queues and analytics.

### 02 — Customer directory exposes unrelated customer data

Evidence: [customer routes][customer-routes], [controller][customers] `list` / `getOne`, and [repository][customer-repo]. Customer-role users are allowed; list queries do not restrict by the authenticated customer, and detail accepts an arbitrary entity ID. Responses include contact/tax data, related addresses and record counts when populated.

Mock observation: a synthetic company-A customer received company-B list and detail data with status 200.

Fix: distinguish a tenant employee's customer-directory permission from a customer's self-service profile permission. Restrict each query before retrieval and return explicit field allowlists.

Acceptance: customer A cannot enumerate customer B or retrieve B by a known ID; directory access requires a separately authorized tenant role.

### 03 — Caller-controlled order/company ownership

Evidence: [order controller][create] `create`, `previewImport`, `confirmImport`; [mapper][mapper]; [import workflow][import]. The request's `customerEntityId` takes precedence over the authenticated user's value. Address-book saves and imported orders use that supplied ID.

Impact: callers can attach orders or saved addresses to another customer/company record. The existing customer-directory leak makes target IDs discoverable.

Fix: resolve tenant and permitted customer ownership from authenticated membership. Permit on-behalf-of creation only through an explicit permission and a same-tenant customer lookup. Apply the same service policy to interactive creation and imports.

Acceptance: cross-company IDs are rejected before any address, order, label job or payment record is written.

### 04 — Cross-owner address references

Evidence: [mapper][mapper] `mapCreateOrderDtoToRepoPayload` resolves sender addresses using a client-supplied customer ID and receiver addresses by ID alone. [Order write repository][write] `assertFkExists` verifies existence, not ownership. Created orders include associated address objects.

Impact: a known address ID can be read/reused through an unrelated order. Validating an ID as a UUID does not authorize it.

Fix: resolve every referenced object within the trusted tenant and permitted customer scope. Enforce matching tenant IDs in foreign keys. Model explicitly shared/public destination addresses separately, if the business needs them.

Acceptance: sender and receiver IDs from another tenant are rejected; related responses cannot leak their contents.

### 05 — Inconsistent warehouse object authorization

Evidence: [label controller][labels] allows warehouse-role users without a warehouse check; [tracking controller][tracking] treats warehouse role as sufficient. [Order read controller][read] applies a warehouse check to detail but exposes global driver workloads to warehouse users. Warehouse listing is also global.

Earlier isolated observation: the same warehouse-A actor requesting a warehouse-B order received 403 for detail but 200 for label URL and tracking functions.

Fix: one shared order/resource policy for detail, tracking, labels, proof files, cash and workload APIs. Apply a tenant restriction first and warehouse/assignment restrictions second.

Acceptance: each representation of an inaccessible order remains inaccessible. Positive tests must preserve authorized transfers and assignments.

### 06 — Absent scope can fail open

Evidence: [address controller][addresses] can pass an absent customer ID; [address repository][address-repo] then omits its ownership filter. [Live-map stream][live-map] only applies warehouse filtering if `warehouseId` exists; it also admits location events whose warehouse ID is absent. Manager user creation permits a warehouse-role account without a warehouse assignment.

Qualification: normal customer registration creates a customer entity, so the address case requires missing/inconsistent legacy data or claims. The warehouse stream case is a separate reachable configuration risk, not proof that every warehouse request is unscoped.

Fix: require the necessary organization context; missing values must mean no access. Handle unassigned-driver visibility through an explicit dispatch permission.

Acceptance: null, omitted and stale scope values never broaden the result set or stream.

### 07 — Password hashes in warehouse responses

Evidence: [warehouse repository][warehouse-repo] `getWarehouseById` uses `include: { users: true }`. [Warehouse controller][warehouses] returns that object unchanged. `User.password` is a persisted scalar field.

Mock observation: a synthetic password-hash sentinel survived serialization. The route is manager-only: this is not anonymous disclosure, but managers should not receive other users' authentication material.

Fix: explicit safe projections at repository and response boundaries; do not depend on each controller remembering to remove fields.

Acceptance: recursively inspect API responses for password, token hash, secrets and recovery fields. A populated warehouse response contains none.

### 08 — Manager role is global and over-broad

Evidence: [user repository][users] `createUserAsManager`, `listUsers`, `deleteUserAsManager`; manager guards on warehouse, pricing, finance and export endpoints. Managers can create other managers and reference globally existing warehouses/customer companies.

Impact: assigning “manager” for one company effectively grants platform-wide authority. Administration, operational changes and financial settlement are not sufficiently separated. Some protections exist: self-deletion is blocked and direct manager cash collection is disabled.

Fix: separate platform administration, tenant administration, operations and finance. Enforce grant ceilings, tenant membership checks and independent approval for sensitive privileges or financial overrides. Tenant administrators must not administer global identities or memberships belonging to other tenants.

Acceptance: an administrator cannot grant a role outside their authority; all grants and exceptional access are audited.

### 09 — Tenant isolation is absent from derived data

Evidence: [manager controller][manager], [analytics cache][cache] `makeScopeKey` returns role/warehouse scope, and [live-map controller][live-map] uses role/warehouse snapshot keys. Manager aggregates are global. Analytics invalidation is broadcast without tenant filtering.

Impact: adding tenant filters only to order queries would leave cached responses and event paths capable of cross-tenant disclosure. Analytics invalidation currently exposes activity metadata, not necessarily complete business records. Socket.IO joins global role rooms, but inspected notification sends target user rooms; a data leak through a role-room broadcast was not demonstrated.

Fix: include tenant and relevant authorization scope/version in cache keys, computations, notifications, channels and jobs. Reauthorize subscriptions and downloads.

Acceptance: warm a cache as tenant A, repeat as B, and verify no A data or unauthorized event reaches B.

### 10 — No database-enforced tenant isolation

Evidence: [schema][schema] and supplied migrations contain no tenant model, tenant-matching composite foreign keys or row-level security policies.

Impact: authorization rests on manually written application queries. An omitted filter or cross-tenant relationship can violate isolation even after route patches.

Fix: use either provisioned database isolation per tenant, or rigorously enforced shared-table tenant keys plus PostgreSQL RLS as defense in depth. Add composite references such as `(tenant_id, warehouse_id)` to the corresponding warehouse key. Shared/global reference data needs explicit classification.

Acceptance: direct queries under the application database role cannot read/write another tenant, and cross-tenant foreign-key connections fail. Lack of RLS alone is not an exploit; the missing tenant model and observed query flaws make this gap important here.

### 11 — Clients can assert that money is already paid

Evidence: [mapper][mapper] accepts `codPaidStatus`, `serviceChargePaidStatus` and `serviceCharge`; [write repository][write] persists them. [Cash seed logic][cash-seed] skips expected collection rows when status is `PAID`. CSV import exposes these flags too.

Mock observation: identical monetary inputs produced two expected cash records when unpaid and zero when both client flags were `PAID`.

Fix: separate customer-entered shipping instructions from authoritative payment state. Set paid status only through verified payment events or a privileged, audited reconciliation workflow. Define legitimate customer-reported COD collection instructions separately.

Acceptance: changing a customer request's payment flags cannot settle or suppress an obligation.

### 12 — Client controls checkout amount

Evidence: [order controller][create] passes mapped `amount` directly to `createInvoice` and `createStripePayment`; [invoice repository][invoice-repo] builds checkout from that value. The tariff quote endpoint exists but is not the authoritative pricing step in this creation path.

Condition: `PAYMENTS_ENABLED=true`. Earlier isolated observation forwarded 0.01 to both invoice and checkout dependencies. This demonstrated the trust boundary, not a live payment or fulfillment bypass.

Fix: calculate price, currency, taxes and approved discounts server-side from a versioned quote. Bind payment to the stored order and quote. Reject unsupported currencies and overrides.

Acceptance: modifying client `amount` does not modify the amount owed or charged; fulfillment checks verified payment policy.

### 13 — Currency and monetary precision

Evidence: financial amounts use `Float` in [schema][schema]; [checkout][invoice-repo] always uses EUR while order currency is separately supplied.

Impact: rounding/reconciliation errors and mismatched currency interpretation, depending on supported business currencies.

Fix: use exact decimals or integer minor units with an explicit currency model and that currency's exponent. Do not assume every currency has two decimal places. Store the currency on the authoritative invoice/payment and reconcile it consistently.

Acceptance: rounding-boundary cases, large amounts and supported currencies agree across quote, invoice, provider event and cash ledger.

### 14 — Partial writes and unsafe retries

Evidence: [create][create] writes addresses/order/labels before payment amount validation. Earlier mock: a missing amount returned 400 after one order write. [Import][import] writes and labels orders sequentially without a durable batch checkpoint. S3 uploads happen before the proof database transaction.

Impact: an error response can conceal successful partial work; retries can duplicate orders or side effects and failures can leave orphaned files.

Fix: validate and authorize before writes; use a transaction for related database changes, tenant-scoped idempotency keys and an outbox for external side effects. Track import row outcomes durably; reconcile orphaned uploads. Do not hold database transactions open around slow external calls.

Acceptance: retries and simulated failures at each boundary produce one business operation with a recoverable state.

### 15 — Payment webhook reconciliation

Evidence: [webhook][webhook] correctly verifies a Stripe signature against the raw body, but selects an invoice from metadata, marks it paid, then generates/uploads a PDF. It does not compare stored amount/currency/session binding, and its duplicate check is a read-before-write check rather than durable event deduplication.

Qualification: signature verification is a real control. Arbitrary unsigned webhook forgery was not demonstrated; the current checkout is card-only. Do not equate a missing explicit payment-status check with a proven unpaid-card exploit.

Fix: store checkout/provider identifiers, deduplicate events atomically, reconcile amount/currency/payment status, and enqueue document generation after the payment transaction. Keep retries and reconciliation alerts.

Acceptance: duplicate, concurrent, unexpected and mismatched signed events cannot create contradictory payment states.

### 16 — Cash transition races

Evidence: [cash service][cash] reads collection state and later updates by ID inside a transaction, without a version/state predicate or explicit locking/isolation strategy in these paths.

Risk: concurrent collect/handoff/settle actions may overwrite a newer state or append inconsistent history. A transaction alone does not make an earlier state check immutable. A real PostgreSQL concurrency test is still needed.

Fix: use optimistic versions or appropriate row locking/serializable transactions with retries, enforce legal transitions, and add unique operation IDs.

Acceptance: simultaneous conflicting transitions yield one valid transition or a clean retry/conflict, with consistent ledger history.

### 17 — Password changes leave refresh sessions active

Evidence: [user repository][users] `changeUserPassword` updates the password hash only. Mock observation confirmed zero refresh-session operations.

Impact: someone holding a stolen refresh token may continue renewing access after the owner changes their password. Password change is not a reliable compromise-recovery action here.

Fix: revoke affected refresh-token families and invalidate the account/session authorization version as part of the password-change transaction. Specify whether the initiating session is reissued. Add a revoke-all-sessions recovery action.

Acceptance: old refresh tokens fail after password change; old access tokens and live connections expire/revoke according to a documented short window.

### 18 — Stale privileges and long-lived connections

Evidence: [auth middleware][auth] defaults to `token_or_cache` and accepts populated role/organization claims without checking the current database account. Defaults include 30-minute access tokens. [Realtime hub][realtime] checks identity at connection; stream controllers do not implement token-expiry disconnection or membership-change revalidation.

Mock observation: claim handling permitted a synthetic deleted manager without a database lookup; the signature verifier was mocked, so this is not a JWT-forgery test.

Fix: active membership/session version checks with bounded caches and invalidation, short-lived scoped tokens, and revocation/expiry handling for WebSockets and SSE.

Acceptance: account disablement or tenant/role removal prevents subsequent sensitive work and terminates affected subscriptions within the required window.

### 19 — Refresh rotation concurrency and reuse evidence

Evidence: [users][users] `refreshUserSession` checks active status before its transaction, updates by session ID without an active-state predicate, and deletes revoked session records. This loses useful token-family reuse history.

Risk: revocation interleavings need testing; retaining a revoked record alone is not sufficient if the rotation write ignores its latest state. Concurrent double rotation was not proven; the deletion behavior can affect the outcome.

Fix: atomically consume only an active session, retain bounded token-family/replacement history, detect reuse and revoke the family. Define recovery for benign simultaneous browser refreshes.

Acceptance: deterministic interleavings of refresh/refresh and refresh/logout cannot resurrect a revoked session.

### 20 — JWT validation policy

Evidence: [auth][auth], [users][users] and [realtime][realtime] call signature verification without explicit issuer/audience/algorithm allowlists; token type is accepted when absent. Tenant and membership-version claims are not modeled.

Qualification: signature and expiry verification exist. HMAC is not inherently broken, and no algorithm-confusion exploit was demonstrated.

Fix: document and enforce trusted issuers, intended API audience, allowed algorithms, required expiry/subject/type and validated tenant context. Separate access and refresh token use, and provide a key-rotation strategy.

Acceptance: tokens for another application, environment, purpose or tenant are rejected even if issued by a related trusted system.

### 21 — Authentication lifecycle hardening

Evidence: six-character minimum passwords in [users][users]; public registration; no integrated MFA, email verification, account suspension/recovery workflow or per-account abuse controls found in this snapshot. Login already uses a generic invalid-credentials message and password hashing.

Impact: weak credential protection and incomplete handling of compromised/offboarded users. Public registration is not inherently a vulnerability, but must not provide entry to tenant employee privileges.

Fix: an established identity provider with MFA for privileged users, stronger password/breached-password policy where local passwords remain, verified invitations, safe recovery and account lifecycle management. Combine per-account and per-source throttling without easy account-lockout denial of service.

Acceptance: privileged accounts require the chosen stronger authentication, and invitations cannot assign unauthorized tenant roles.

### 22 — Unsafe proof-file content

Evidence: [proof controller][proof] accepts a client `signatureSvg` if it starts with `<svg`, stores it as SVG, and uses a caller-supplied photo MIME type and filename extension without actual image validation. The assigned driver is checked, and a file-size limit exists.

Risk: active content or unexpected file types can reach a recipient through a signed object URL. Script execution depends on how content is opened, MIME/headers and origin; application-origin stored XSS was not proven.

Fix: generate signatures from bounded validated numeric paths, or rasterize; decode/re-encode accepted photo formats; reject other content, strip metadata where appropriate, scan/quarantine files and serve downloads from an isolated origin with safe headers. Authenticate and scope the object before signing a URL.

Acceptance: active SVG/HTML, deceptive MIME types and oversized/decompression-heavy images never become trusted proof attachments.

### 23 — Proof timestamps are client-controlled

Evidence: [proof][proof] maps request `savedAt` to a tracking event timestamp.

Impact: an assigned driver can backdate/future-date evidence, affecting chronology and operational reports. A drawn signature alone does not establish enterprise-grade non-repudiation.

Fix: retain immutable server `receivedAt`; treat device capture time as separately labeled untrusted evidence with plausibility checks. Version corrections, record actor identity and content hashes, and preserve an audit trail.

Acceptance: changing the device timestamp cannot rewrite authoritative receipt chronology.

### 24 — Spreadsheet formula injection

Evidence: [read controller][read] `csvEscape` wraps values in quotes but does not neutralize formula-leading content. Exported sender/receiver/address/name values can originate from customers.

Risk: a spreadsheet opening the CSV may interpret a malicious value as a formula. Actual execution or data transfer depends on the spreadsheet and its settings; a live spreadsheet exploit was not run.

Fix: apply a tested text-cell export policy that handles formula prefixes and control characters, or generate typed spreadsheet cells as text. Preserve original business data separately; quoting alone is insufficient.

Acceptance: dangerous prefixes remain literal text in the supported spreadsheet applications. [OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection).

### 25 — Resource and cost controls

Evidence: request/upload sizes and export row limits exist, but [import][import] lacks a business row-count budget; [mapper][mapper] lacks a parcel-count maximum; upload parsing uses memory; proof/PDF/S3 work and long-lived connections lack comprehensive user/tenant concurrency budgets. Bulk warehouse detail includes unpaginated relations.

Impact: a valid account can consume disproportionate memory, database work, file generation or storage. This is not a claim that every endpoint is unlimited; the JSON body cap still applies.

Fix: enforce bounded counts and strings, tenant quotas, job admission limits, upload budgets, connection limits, timeouts and backpressure. Authorize the resource before expensive processing when possible.

Acceptance: one tenant cannot exhaust the shared service or create uncontrolled costs under agreed load limits.

### 26 — Rate-limit failure behavior and webhook coverage

Evidence: [application entry][app], [order routes][order-routes] and [store adapter][ratelimit] use `passOnStoreError: true`. In Redis-backed mode, a store failure allows requests through. The Stripe webhook is mounted before the global limiter. In-memory fallback across replicas does not provide a single global limit.

Fix: define endpoint-specific degraded behavior, bounded local fallback where appropriate and upstream protection. Protect webhook receipt with a provider-compatible capacity policy and queue verified events. Alert when the security store fails.

Acceptance: Redis outages and webhook floods produce controlled degradation, not unrestricted expensive processing.

### 27 — Label queue recovery and starvation

Evidence: [label workflow][label-jobs] claims pending/failed jobs with a compare-and-update guard, which is good. It does not reclaim abandoned processing leases in the inspected implementation. Exhausted failed jobs can occupy the limited candidate query, then be skipped in code.

Risk: crashed workers strand labels; accumulated exhausted jobs can starve fresh jobs. These are availability/integrity findings, not a demonstrated remote-code-execution issue.

Fix: lease expiry/renewal and recovery, a distinct dead-letter state, eligible-job filtering, retry limits and monitored reprocessing. Include tenant context and fairness in scheduling.

Acceptance: worker death recovers work; a full batch of exhausted jobs does not block new eligible jobs.

### 28 — Database and Redis exposure defaults

Evidence: [Compose][compose] publishes PostgreSQL and Redis host ports. Redis has no password/ACL configuration in that service definition, and PostgreSQL has a predictable fallback password.

Qualification: this does not establish that the AWS instance exposes those ports publicly. Host firewall, security groups and production configuration were not supplied.

Fix: keep stateful services on private networks, remove unnecessary host publication, enforce strong credentials/ACLs and encrypted connections appropriate to the deployment. Fail production startup on unsafe defaults.

Acceptance: only authorized application/workload identities and networks can reach the database and Redis. Verify actual AWS rules, not just Compose.

### 29 — CORS and reverse-proxy assumptions

Evidence: [app][app] and [realtime][realtime] allow arbitrary origins when the configured list is empty; credentials are enabled. Express trusts one proxy hop unless disabled.

Qualification: CORS is not authentication, and bearer-header APIs do not automatically have a cookie-CSRF flaw. Proxy-header spoofing depends on the real topology and whether direct backend access is possible.

Fix: require an explicit production origin list; configure proxy trust for the deployed topology and prevent bypass of the trusted ingress. If cookies are used, separately define CSRF and cookie protections.

Acceptance: disallowed browser origins fail, and client-supplied forwarding headers cannot bypass identity/rate controls.

### 30 — Workload credentials and privilege separation

Evidence: [S3 config][s3] explicitly builds credentials from access-key environment variables instead of the default workload role chain. [Entrypoint][entrypoint] runs migrations using the application's environment. API and worker services share an environment-file pattern.

Qualification: no working secret or actual IAM policy was verified. Environment variables alone are not proof of secret disclosure, and the runtime does drop privileges to an application OS user.

Fix: short-lived workload roles, least-privilege access per API/worker, managed secrets and rotation. Separate migration ownership from runtime database rights. Isolate development, test and production credentials and data. [AWS IAM best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html).

Acceptance: runtime identity cannot migrate/drop schema or access unrelated buckets; revoking a workload identity has a documented blast radius.

### 31 — Auditability and sensitive-data handling

Evidence: shipment/cash histories exist, but no comprehensive security audit trail for authentication lifecycle, privilege changes, denied access, exports and exceptional access was found. Full-row address/customer responses can include unnecessary sensitive fields. [App][app] health errors and several controllers return internal exception messages; diagnostic logging can include operational data.

Fix: explicit response projections, data classification and minimization, retention rules for locations/proofs/identity fields, redacted structured logs, generic external errors and correlation IDs. Send security events to an independently protected audit destination with controlled retention. Never log tokens or password hashes.

Acceptance: investigators can identify actor, tenant, action, object, decision and timestamp without exposing secrets; tenant users cannot modify security history. Privacy/legal compliance requires a separate assessment.

### 32 — Security assurance and release controls

Evidence: [build workflow][ci] installs, builds and publishes images, but does not visibly run tests, tenant-isolation regressions, dependency/security scans or image-policy gates. Source tests exist; their presence is not evidence of complete security coverage. Build tags include both `latest` and commit SHA.

Gap: dependency CVEs, deployed-image provenance, secret history, branch protection, production patching, backup restoration and incident response were not verified.

Fix: threat model and security tests; reviewed dependency updates; SAST/SCA/secret/image scans; least-privilege CI credentials; pinned/protected build inputs; SBOM/provenance and deployment by immutable digest; separate environments and restoration exercises.

Acceptance: security regressions fail the release pipeline and the exact reviewed image can be traced to source. Do not describe dependencies as vulnerable without checking the resolved versions and advisories.

## What was actually exercised

Seven additional observations were produced in this review using original TypeScript functions loaded into an isolated Node VM with mocked database and external dependencies:

| Scenario | Observed result | Limit |
|---|---|---|
| Company-A customer lists customers | Returned fake B; query scope `{}` | No real database or HTTP server |
| Company-A customer requests B by ID | 200 with fake B | Same |
| Warehouse detail contains a fake user password hash | Hash field survives response | Manager route gate inspected separately |
| Address repository receives no customer scope | Query scope `{}` | Conditional missing-scope state |
| Paid flags on identical cash inputs | Unpaid: 2 expected records; paid: 0 | Cash-seeding function, not full checkout |
| Password change | Password update; 0 refresh-session operations | Password comparison/hash mocked |
| Default auth receives verified deleted-manager claims | Allowed; 0 database lookups | JWT verifier mocked; not token forgery |

Earlier isolated checks on this same uploaded snapshot also exercised warehouse detail versus label/tracking authorization, caller-selected company during order creation, client-supplied checkout amount, and order persistence before payment validation. The creation test stubbed the DTO mapper; the real mapper and repository were separately inspected for the relevant accepted fields and missing ownership restrictions.

No SQL injection, command execution, secret leak, exploitable dependency CVE, publicly accessible AWS database, or application-origin XSS is claimed as proven by this work.

## Immediate containment and implementation order

1. Keep the public demo limited to synthetic data; do not onboard mutually untrusted companies yet. Review whether any real data is already present without sharing it in chat.
2. Close customer-directory and order/address ownership paths; remove password fields; make label/tracking/stream scope fail closed; revoke sessions on password changes.
3. Remove client authority over paid status and checkout price. Disable payment-dependent fulfillment paths until pricing/reconciliation tests pass.
4. Verify actual network exposure, access keys, bucket access and production defaults. Rotate secrets only if exposure or policy requires it; no live secret was proven compromised here.
5. Introduce tenant ownership, memberships, unified authorization and database isolation with a reviewed migration plan. Audit pre-existing cross-owner relationships; quarantine ambiguous rows.
6. Scope caches, object storage, jobs and streams; implement idempotency, safe uploads, quotas, audit trails and concurrency controls.
7. Run an independent staging security test against two synthetic tenants, then review production configuration before any real pilot.

## Enterprise target architecture — SAP-inspired, adapted to CargoPilot

SAP is a family of products, not one security architecture. The design below borrows published concepts from SAP S/4HANA Cloud and SAP CAP/BTP; it is an architecture recommendation for your Node/Prisma/AWS backend, not SAP's internal blueprint or a claim of equivalent assurance.

SAP S/4HANA Cloud separates business catalogs/roles from restrictions on which organizational data may be accessed, such as company-code values. CargoPilot needs that distinction between permission and data scope. [SAP business-role restrictions](https://learning.sap.com/courses/managing-user-identity-and-access-in-sap-s-4hana-cloud-public-edition/maintaining-business-role-restrictions_e9b93fbd-3a0e-4263-af70-8d4fded52f1a).

SAP CAP's authorization model combines allowed operations, roles and instance filters. Its multitenancy guidance demonstrates isolation between tenants. These are complementary controls, not interchangeable ones. [SAP CAP authorization](https://cap.cloud.sap/docs/guides/security/authorization), [SAP CAP multitenancy](https://cap.cloud.sap/docs/guides/multitenancy/).

### A. Identity and organization model

| Object | Responsibility |
|---|---|
| `User` / identity subject | Global human identity, linked to an established identity provider; no global tenant-admin role |
| `Tenant` | Independent subscribing organization and security boundary |
| `TenantMembership` | User's active membership and roles in one tenant; same user may have different roles in another |
| `CompanyUnit` | Optional legal/business unit within a tenant; not automatically a separate security tenant |
| `Warehouse` | Belongs to one tenant and optionally a company unit |
| `CustomerEntity` | Customer master record inside a tenant, not the tenant itself |
| `Permission` / role bundle | Named business actions such as `order.read`, `order.assign`, `invoice.reconcile` |
| `ScopeGrant` | Permitted company units, warehouses, customer accounts or assignments |

On tenant switching, validate membership and create an explicit tenant-scoped session/context. Never union permissions across tenants. A browser-selected tenant ID, URL prefix or header is only a selection request—not evidence of authorization.

If a logistics operator genuinely shares shipments with other companies, model explicit cross-tenant agreements, limited shared resources and revocation. Do not turn off the tenant boundary to support transfers.

### B. Request and data boundaries

| Layer | Required enforcement |
|---|---|
| Identity provider | OIDC/SSO, MFA for privileged actions, verified enrollment, secure recovery and offboarding |
| Edge/ingress | TLS, restricted backend reachability, request caps, abuse protection and trusted proxy configuration |
| API authentication | Validate issuer, audience, signature, expiry and token purpose; resolve active membership/session |
| Authorization service | Deny by default; check action permission, tenant, warehouse/customer scope, ownership and workflow state |
| Business service | Authoritative prices/payment state, legal transitions, separation of duties, input allowlists and idempotency |
| Persistence | Tenant-scoped queries, composite relationships and the chosen database isolation boundary |
| Files, cache, jobs, streams | Carry trusted tenant context and apply the same object authorization independently |
| Audit/security operations | Independent security events, alerts, incident handling, retention and restoration evidence |

Core rule: **authenticated AND active membership AND same tenant AND permitted action AND permitted organizational/object scope AND valid workflow.** A manager does not bypass the same-tenant condition. Deny when mandatory context is missing. This follows the general multi-tenant security principle of propagating and enforcing trusted tenant context across layers. [OWASP multi-tenant security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html).

### C. Database isolation choice

For a shared PostgreSQL deployment, require `tenant_id` on every tenant-owned row; use tenant-leading indexes, tenant-scoped natural uniqueness, and matching composite foreign keys. Global reference tables must be deliberately identified and read-only to tenant users.

Add RLS as a second boundary against omitted predicates. Run the API as a non-owner, non-superuser role without `BYPASSRLS`; ensure tenant tables have suitable `USING` and `WITH CHECK` policies. Consider `FORCE ROW LEVEL SECURITY` where appropriate. PostgreSQL documents owner and privileged-role bypass behavior, which must be addressed rather than assumed away. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

With connection pooling, set tenant context transaction-locally and execute all protected queries on that same transaction/connection. Never leave session-wide tenant state on a pooled connection. A tenant variable supplied by a fully compromised application is not a cryptographic barrier; RLS primarily guards query mistakes in this design, and stronger workload/database isolation may be needed for a stronger threat model.

Database-per-tenant is an alternative with stronger operational separation and higher provisioning/migration/backup overhead. Decide from sensitivity, customer contracts, scale and operations capacity. Neither choice removes the need for API, file, cache and worker authorization.

### D. Business roles and separation of duties

| Role | Example permissions | Important exclusions |
|---|---|---|
| Customer user | Create/read own authorized customer orders | Other customer records; paid-state overrides |
| Warehouse operator | Receive/dispatch assigned warehouse shipments | Unassigned warehouses; finance/admin |
| Dispatcher | Assign drivers and routing within granted organization scope | User administration; independent settlement |
| Driver | Assigned tasks, bounded location updates and delivery evidence | Unassigned orders; price changes |
| Finance operator | Reconcile payments and cash within scope | Tenant-role grants; unreviewed self-approval |
| Tenant administrator | Manage memberships and permitted roles in their tenant | Other tenants; unrestricted platform operations |
| Auditor | Read authorized records and protected audit history | Business-data mutation; audit deletion |
| Platform operator | Tenant provisioning and infrastructure operations | Routine unrestricted tenant business-data access |

Require separate approval for sensitive role grants, refunds, price overrides or cash adjustments according to the business risk. Platform support access should be time-limited, justified and audited; emergency access must be exceptional, not the normal manager role.

### E. Files, integrations and asynchronous work

Use private object storage with tenant-prefixed keys plus real access policy enforcement; prefixes alone are not authorization. Store tenant/order ownership in attachment metadata records, reauthorize before short-lived signed URLs, and avoid logging those bearer URLs. Isolate active/untrusted file content and scan or transform it before distribution.

Cache keys should include tenant, resource, filters and relevant permission scope/version. Job payloads and outbox records must contain tenant context established by the server, an operation ID, and minimal data. Workers validate it, use narrowly scoped identities and cannot treat an arbitrary payload tenant ID as trusted. Apply per-tenant fairness, lease recovery, dead-letter handling and replay-safe processing.

Authorize WebSocket/SSE channels at subscription, filter every event by scope, handle revocation and reconnection, and bound connection lifetime and count. Service-to-service integrations need dedicated scoped service identities, not reused human manager tokens.

### F. Auditing and operational assurance

Maintain actor, tenant, action, resource, decision, correlation ID, authoritative time and justified before/after changes for sensitive operations. Send protected audit records to a destination outside ordinary tenant modification rights. SAP CAP explicitly supports security-event, configuration-change and personal-data audit categories; the equivalent CargoPilot control needs both application events and operational retention/protection. [SAP CAP audit logging](https://cap.cloud.sap/docs/guides/security/dpp-audit-logging).

Encrypt transport and stored sensitive data, manage key access, test tenant-aware backup restoration, and document incident response and customer offboarding/deletion. A security architecture is incomplete without operators, alerts, recovery drills and release evidence.

### G. Minimum release acceptance matrix

Use tenants A and B, two warehouses each, customer/driver/warehouse/manager/finance actors, and one user with different memberships in both tenants.

- Test list/detail/create/update/delete/bulk/import/export and every related file endpoint. Known foreign IDs, nested relations and missing tenant values must not bypass isolation.
- Test warm caches, analytics, background jobs, notifications, signed URLs and live streams across the same boundary.
- Verify grant ceilings, membership revocation, password/session recovery, wrong-audience tokens and stale connections.
- Verify server pricing, paid-state protection, idempotent payment events, concurrent cash actions and failure recovery.
- Run malformed-file/formula/resource-abuse tests, direct database-role isolation tests, dependency and infrastructure review, and a backup restoration exercise.

**Enterprise readiness is the demonstrated result of these controls and tests—not the presence of a JWT, a roles enum, or an architecture diagram.**

[schema]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/prisma/schema.prisma
[customer-routes]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/customers/customerRoutes.ts
[customers]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/customers/customerEntityController.ts
[customer-repo]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/customers/customerEntityRepo.ts
[create]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/controller/create.controller.ts
[mapper]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/orderCreate.mapper.ts
[import]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/workflow/import/order-import.workflow.ts
[write]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/repo/order-write.repo.ts
[read]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/controller/read.controller.ts
[labels]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/label/labelController.ts
[tracking]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/tracking/trackingController.ts
[addresses]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/addresses/addressController.ts
[address-repo]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/addresses/addressRepo.ts
[live-map]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/liveMap/liveMapController.ts
[warehouse-repo]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/warehouse/warehouseRepo.ts
[warehouses]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/warehouse/warehouseController.ts
[users]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/users/userRepo.ts
[manager]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/manager/managerController.ts
[cache]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/manager/analyticsV2Cache.ts
[cash-seed]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/cash/cashCollection.shared.ts
[cash]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/cash/cashCollection.service.ts
[invoice-repo]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/invoice/invoiceRepo.ts
[webhook]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/stripe/webhookRoutes.ts
[auth]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/middleware/auth.ts
[realtime]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/features/realtime/realtimeHub.ts
[proof]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/controller/proof.controller.ts
[app]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/index.ts
[order-routes]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/orderRoutes.ts
[ratelimit]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/config/rateLimitStore.ts
[label-jobs]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/services/orders/workflow/label/order-label.workflow.ts
[compose]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/docker-compose.yml
[s3]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/src/config/s3.ts
[entrypoint]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/docker-entrypoint.sh
[ci]: sandbox:/workspace/scratch/e3d6d13c658a/cargopilot-review-hm7a4qgt/cargopilot-backend-main/.github/workflows/docker-build.yml
