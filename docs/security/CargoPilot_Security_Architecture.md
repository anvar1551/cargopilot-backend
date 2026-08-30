# CargoPilot Security Architecture and Review Contract

## 1. Purpose and evidence baseline

This document defines CargoPilot's approved target security architecture, review contract and release-safety expectations. It is authoritative for future design and security review, but it does not claim that every target control is currently implemented.

The source-evidence baseline for this document is local checkpoint:

`ec3282cfb1737d90d474eab5e5f504b5a6443d17`

Architecture claims must be classified as one of:

- **Current enforced behavior:** demonstrated by current source and the stated validation level.
- **Planned target architecture:** approved design that is not yet implemented end to end.
- **Partially migrated compatibility behavior:** current behavior that implements only part of the target or retains legacy semantics.
- **Unverified infrastructure assumption:** deployment, network, IAM, Redis, database or external-provider behavior not validated against the relevant environment.

Passing unit tests do not prove complete tenant isolation, PostgreSQL concurrency behavior, Redis behavior or deployed infrastructure security.

## 2. Scope and non-goals

### 2.1 Scope

This contract covers:

- authentication, sessions and enrollment;
- tenant membership and tenant selection;
- RBAC, typed organizational scopes and grant ceilings;
- ownership of legal entities, warehouses, customers, addresses and operational records;
- orders, pricing, invoices, payments, cash, settlements and finance subledger behavior;
- integrations, webhooks, uploads, exports, queues, jobs, events, caches and realtime channels;
- audit, privacy, migration safety, dependency assurance and infrastructure verification;
- evidence and negative-test requirements for security-sensitive work.

### 2.2 Non-goals and non-claims

CargoPilot finance is operational logistics finance and a controlled subledger. It is not statutory accounting, general-ledger software, SAP-equivalent accounting or a compliance-certified finance platform.

This contract does not claim that CargoPilot currently provides:

- complete tenant isolation;
- certified financial or statutory accounting controls;
- production-hardened platform administration;
- verified AWS, network, PostgreSQL or Redis hardening;
- exploitability of every dependency advisory;
- compliance with a named regulatory framework.

Security remediation must not expand finance scope into statutory accounting unless separately justified and approved.

## 3. Current enforcement versus target architecture

### 3.1 Current and partial behavior at the baseline

- **Partially migrated compatibility behavior:** `CompanyMembership`, membership roles, permissions and generic membership scopes provide some company and scope enforcement.
- **Partially migrated compatibility behavior:** company ownership exists on selected records but is not universal across tenant-owned data.
- **Partially migrated compatibility behavior:** finance has exact-decimal models, source events, journals, outboxes, audit events and maker-checker checks in selected flows.
- **Partially migrated compatibility behavior:** payment providers, integration providers and webhook processing have signatures and idempotency mechanisms in selected paths, but authority and retention boundaries are incomplete.
- **Current enforced behavior:** server services perform authorization checks in many protected routes and business flows.
- **Current enforced behavior:** current finance functionality is operational finance and subledger functionality, not statutory accounting.
- **Unverified infrastructure assumption:** deployed network boundaries, Redis controls, PostgreSQL roles, IAM permissions, TLS and secret injection have not been established by this document.

### 3.2 Planned target

- `Tenant` becomes the security root.
- `TenantMembership` binds a user to one tenant and is the authority for tenant-scoped sessions.
- Every tenant-owned record belongs to exactly one tenant.
- Same-tenant relationships are enforced at API, service, repository and database levels.
- All derived and asynchronous boundaries carry tenant context.
- Financial values and states come only from authoritative server-side records and verified external events.

`Tenant` and `TenantMembership` remain planned target architecture until schema, migrations, services, relational constraints and negative tests prove enforcement.

## 4. Threat model and trust boundaries

### 4.1 Actors

- anonymous callers;
- tenant users;
- tenant administrators;
- customer users;
- warehouse users;
- drivers and mobile clients;
- support operators;
- finance makers and checkers;
- integration service identities;
- payment, carrier, messaging and webhook providers;
- future platform administrators;
- build, deployment and background-worker identities.

### 4.2 Protected assets

- credentials, session and refresh-token state;
- tenant memberships, roles, permissions and scopes;
- customer, address, warehouse, driver and employee information;
- orders, parcels, routes, tracking, labels and delivery evidence;
- pricing, invoices, payment intents, refunds, cash custody and settlements;
- journals, subledger projections, bank statements, payment runs and reconciliation records;
- provider credentials, webhook events and integration messages;
- files, exports, reports, caches, queues and realtime channels;
- audit history and privileged-access evidence.

### 4.3 Trust boundaries

1. Browser or mobile client to Fastify API.
2. Authentication token to current server-side identity and membership state.
3. Membership, permission and scope resolution to business services and repositories.
4. API and workers to PostgreSQL.
5. API and workers to Redis.
6. CargoPilot to external payment, carrier and messaging providers.
7. Untrusted external webhooks to canonical internal events.
8. Application to object storage and generated exports.
9. CI/CD and container images to deployed runtime identities and secrets.

### 4.4 Primary threat scenarios

- anonymous enrollment selecting a privileged role or victim company;
- an authenticated user guessing or submitting another tenant's resource ID;
- absent tenant or scope context producing an unfiltered query;
- client-supplied payment values suppressing or changing financial obligations;
- duplicate or concurrent requests applying a financial transition twice;
- a worker treating Redis payload data as authoritative finance state;
- integrations reaching internal or metadata network destinations;
- uploaded active content executing in an operator's browser;
- webhook secrets or credentials being retained in headers or logs;
- spreadsheet formulas executing when an export is opened;
- stale sessions or sockets retaining revoked privileges;
- broad override permissions bypassing actor separation.

## 5. Identity, sessions and tenant membership

### 5.1 Target identity model

A `User` is a global human identity. A user may have memberships in multiple tenants. Membership does not imply a global role.

Each session must be bound to:

- one authenticated user;
- one explicitly selected active tenant membership;
- one tenant;
- an authorization or membership version suitable for revocation.

Tenant context comes from the bound server-side membership, never from an arbitrary request field. A requested tenant ID may identify a desired context, but the server must prove the active membership before binding it.

### 5.2 Session requirements

- Authentication and authorization fail closed.
- Access and refresh tokens have explicit issuer, audience, algorithm and purpose validation.
- Refresh rotation is atomic and supports reuse detection.
- Password changes, suspension, membership revocation and privilege changes invalidate affected sessions and long-lived realtime connections.
- Session and token identifiers are not logged in plaintext.
- Realtime authentication is subject to the same current membership and revocation rules as HTTP.

### 5.3 Current limitation

`CompanyMembership` is partial current enforcement. It must not be represented as the complete target tenant-membership model.

## 6. Tenant, legal-entity and warehouse ownership

### 6.1 Approved ownership decisions

- A tenant is the future security root.
- One tenant may contain multiple tenant-owned legal entities or operational company units.
- A warehouse belongs to exactly one tenant.
- Customers are never directly shared across tenants.
- The same real-world customer may exist as separate tenant-owned customer records.
- Addresses and contacts inherit explicit tenant ownership and must be consistent with their owning customer or operational record.

### 6.2 Joint and 3PL facilities

A warehouse must not obtain multiple tenant owners. A future jointly operated or 3PL facility requires a separate platform-facility model plus explicit tenant contracts, allocations and access policy. Shared physical infrastructure is not shared data ownership.

### 6.3 Database and service enforcement

The target requires:

- non-null tenant ownership for tenant-owned records;
- tenant-leading indexes;
- compound identifiers or unique constraints such as `(tenantId, id)`;
- compound foreign keys that reject cross-tenant relationships;
- repositories that require trusted tenant context;
- services that verify active membership, permission, scope, object ownership and workflow state;
- no empty or omitted scope that becomes an unrestricted query.

PostgreSQL row-level security may be added later as defense in depth. It must not conceal missing application authorization or missing same-tenant relational constraints.

### 6.4 Financial legal-entity isolation

Tenant equality is necessary but not sufficient for entity-specific financial integrity when one tenant contains multiple legal entities.

Every financial transaction, document, obligation, posting, invoice, payment intent, refund, settlement, payable, bank statement, reconciliation record and payment run must have one authoritative tenant and one authoritative legal entity whenever the record is legally or financially entity-specific.

The originating authoritative operational document determines the legal entity. A client, request field, Redis message or worker cannot choose, replace or move that legal entity. Workers reload the authoritative source record before creating or changing entity-specific finance state.

Relationships among entity-specific finance records preserve both tenant and legal entity. The target database design uses suitable compound uniqueness and foreign keys where practical, backed by mandatory application-level checks. A same-tenant but different-legal-entity reference is rejected unless it participates in an explicitly designed intercompany process.

Tenant-level shared master data may exist only where intentionally designed. Shared master data does not grant legal-entity authorization and must not weaken document ownership, posting consistency or entity-specific access controls.

## 7. RBAC, typed scopes and grant ceilings

### 7.1 Authorization invariant

Every protected business operation requires:

```text
authenticated identity
AND active selected tenant membership
AND matching tenant
AND permitted business action
AND permitted typed organizational or object scope
AND valid workflow state
```

Missing context denies access.

### 7.2 Typed scopes

Warehouse, branch, customer, agent and other structural scopes must use typed, validated references with real ownership constraints. A generic `scopeType` and `scopeRefId` pair is not sufficient enforcement unless its referenced object and tenant are validated.

`own` is normally a business-policy predicate, such as `assignedCourierId === actor.userId`, rather than an unrestricted stored scope.

### 7.3 Grant ceilings

- Tenant administrators may grant only roles and permissions within their authorized ceiling.
- System or platform roles cannot be granted through normal tenant role management.
- An actor cannot create a scope assignment for an object outside the selected tenant.
- Holding multiple roles combines allowed actions but never bypasses tenant, object, workflow or segregation-of-duties checks.
- UUID possession is never authorization.

## 8. Enrollment and first-admin bootstrap

Enrollment is invitation-only except for a controlled first-tenant-administrator bootstrap process.

The bootstrap must be:

- explicitly enabled for a new installation or tenant;
- idempotent;
- one-time or transactionally consumed;
- protected by a server-controlled bootstrap credential or deployment ceremony;
- unable to select arbitrary existing tenants or roles;
- fully audited without storing the bootstrap secret;
- disabled after successful completion.

Public self-registration that accepts caller-selected company, tenant, role or permission data is prohibited.

## 9. Platform administration

Routine global-manager access is prohibited. No platform support-access mechanism is required initially.

Any future platform access must be:

- just-in-time;
- time-bound;
- tenant-specific;
- reason-bound;
- strongly authenticated;
- independently approved where required;
- limited to narrowly defined permissions;
- immutably audited and reviewable by the affected tenant where appropriate.

Standing global access must not be introduced as a shortcut for support or development.

## 10. Server-authoritative order and payment rules

### 10.1 Authorization authority

Request-provided company, role, scope, warehouse, customer, address, owner or provider identifiers are not authorization authority. The server must prove that every referenced record belongs to the selected tenant and allowed scope.

If ownership cannot be proven under the partially migrated model, the operation must fail closed.

### 10.2 Financial authority

Request-provided prices, amounts, currencies, paid flags, payment states, settlement states and posting states are not financial authority.

The server must derive authoritative values from:

- approved pricing and tariff configuration;
- the authoritative order or invoice snapshot;
- stored provider configuration;
- verified, replay-protected provider events;
- permitted workflow transitions.

Rejected manipulated requests must produce no database write, outbox message, file write or external side effect.

### 10.3 Payment and webhook reconciliation

- Payment intents use authoritative amount and currency.
- Idempotency keys are tenant-scoped and operation-specific.
- Provider events are bound to the expected tenant, provider, environment, order or invoice, amount and currency.
- Signatures and timestamps are verified before trusted processing.
- Duplicate provider event IDs are idempotently ignored.
- Reconciliation differences create controlled exceptions rather than silently changing financial state.

## 11. Operational finance contract

### 11.1 Boundary

CargoPilot finance supports operational billing, payment collection, cash-on-delivery custody, settlement, payables and controlled subledger behavior needed for logistics operations. Expansion into statutory accounting, tax compliance, consolidated general ledger or certified accounting is out of scope unless separately approved.

### 11.2 Money and state

- Authoritative money uses fixed precision or currency-aware minor units, never JavaScript floating point.
- Currency is explicit on every monetary balance, obligation and transaction.
- Cross-currency activity requires an explicit rate source, rate timestamp and rounding policy.
- Financial state transitions use allowlisted state machines and server authority.
- Posted or finalized records are append-only.
- Corrections use controlled reversals or adjustments linked to the original record.

### 11.3 Transactions, idempotency and outboxes

- Financial mutations are atomic, idempotent, concurrency-safe, auditable and reconcilable.
- The authoritative state change and durable outbox record are committed in the same database transaction.
- Network calls do not remain inside database transactions.
- Workers consume an event identifier and reload authoritative database records before deciding or posting.
- Redis messages may signal work but never become financial authority.
- Idempotency keys include tenant or legal-entity context and operation identity.
- Concurrency is enforced with conditional updates, versions, unique constraints, locks or suitable isolation, not assumptions.

### 11.4 Legal-entity consistency and intercompany activity

- Entity-specific obligations, documents, payments and postings inherit legal entity from their authoritative source document.
- Every relationship and state transition verifies both tenant and legal entity.
- Same-tenant cross-legal-entity links are denied by default and cannot be authorized by a generic override.
- Intercompany activity uses separate traceable documents and postings for each participating legal entity, explicit balancing entries and immutable audit linkage between both sides.
- A correction to one intercompany side cannot silently mutate or orphan the corresponding side.
- Positive tests prove valid same-entity flows.
- Negative tests prove cross-legal-entity references and manipulated legal-entity input are rejected with no database writes, outbox messages, files or external effects.

## 12. Maker-checker and privileged overrides

During the demo, maker-checker behavior uses separate synthetic identities. This does not justify a development bypass.

Controlled journals, settlements, payables, payment runs, period close or reopen, and sensitive finance configuration require actor separation regardless of amount until threshold rules are explicitly approved.

One actor must not create and approve the same controlled transaction merely because that actor holds multiple permissions or roles.

Broad `policy.override` authority is not an approved permanent design. No emergency override is currently approved.

Any future break-glass capability requires:

- a narrow operation-specific permission;
- a recorded reason;
- a short expiry;
- strong authentication;
- independent approval where required;
- an immutable audit event;
- post-use review and alerting.

## 13. Redis, caches, jobs, events and realtime

- Redis is transport or cache only and never the authority for identity, authorization, ownership or finance.
- Workers reload authoritative database state before sensitive decisions.
- Cache, lock, idempotency, job, event, stream and realtime identifiers include tenant context where they contain or control tenant-owned data.
- Background processes apply the same tenant and scope guarantees as synchronous APIs.
- Jobs are idempotent, leased, retryable and recoverable after worker failure.
- Dead-letter and retry records preserve tenant and correlation context without secrets.
- Membership revocation invalidates or disconnects affected realtime channels.
- Redis-unavailable behavior is explicit and tested; production controls must not silently degrade to ineffective multi-instance protection.

## 14. Uploads, storage, exports, webhooks and SSRF

### 14.1 Upload and storage boundary

- Uploaded content is untrusted.
- Validate decoded content, size and dimensions rather than trusting extension or MIME type.
- Active SVG proof content is rejected unless a separately approved safe transformation exists.
- Supported raster evidence is decoded and re-encoded where practical.
- Object keys include tenant and resource ownership context.
- Signed URLs are short-lived and issued only after current authorization.
- Client capture time is stored separately from authoritative server receipt time.

### 14.2 Exports

- Exports use the same tenant, scope and field authorization as API reads.
- Spreadsheet exports neutralize formula prefixes including `=`, `+`, `-`, `@`, tab and carriage return.
- Export jobs and files carry tenant ownership and expiry.

### 14.3 Webhooks

- Verify provider-specific signatures, timestamps and replay identifiers.
- Retain only allowlisted normalized headers needed for verification or support.
- Never retain authorization, cookie, API-key or secret headers in general payloads or logs.
- Canonical events contain tenant, provider, environment, aggregate and correlation identity.

### 14.4 SSRF

Outbound integration requests require:

- parsed and approved protocols;
- configured provider or hostname allowlists where possible;
- DNS resolution checks for IPv4 and IPv6;
- rejection of private, loopback, link-local, metadata and reserved destinations;
- redirect rejection or validation at every hop;
- protection against DNS rebinding and connection-time destination changes;
- bounded connection and request timeouts;
- bounded response sizes;
- redacted operational logging.

## 15. Audit, redaction and privacy

Security-sensitive, administrative, financial and exceptional operations record:

- authoritative tenant and legal entity;
- actor and selected membership;
- action and resource;
- previous and resulting state references where appropriate;
- reason and approval references;
- authoritative server time;
- correlation and idempotency identity.

Audit records must not contain password hashes, tokens, private keys, provider secrets, complete authorization headers, cookies or unnecessary personal data.

Retention periods remain configurable and undecided until real business and jurisdictional requirements are defined. Retention configuration must preserve legal holds, financial traceability and privacy obligations once those requirements exist.

## 16. Migration and rollback contract

No local or deployed database reset, cleanup, migration or reseed is currently approved.

### 16.1 Target migration sequence

1. Expand schema with tenant and membership structures plus nullable ownership fields.
2. Verify schema and compatibility before deployment.
3. Begin dual writes and prove no new unowned records are created.
4. Backfill ownership deterministically.
5. Handle ambiguous or orphaned records explicitly; never assign an arbitrary default tenant.
6. For synthetic demo data, use deterministic mapping or an explicitly approved reset/reseed option.
7. Add tenant-leading indexes and compound uniqueness.
8. Add same-tenant compound foreign keys.
9. Verify API, service, repository and database enforcement.
10. Enforce non-null ownership only after verification.
11. Remove compatibility behavior only after rollback rehearsal and approval.

### 16.2 Derived and asynchronous ownership

Migration includes tenant-scoped:

- idempotency keys;
- cache and lock keys;
- queue jobs and domain events;
- object-storage keys and uploaded files;
- reports and exports;
- realtime rooms and subscriptions;
- audit and correlation records.

### 16.3 Rollback

- Preserve additive fields and compatibility reads during the transition.
- Define verification queries and rollback criteria for every stage.
- Rehearse rollback against synthetic local or approved test data.
- Do not contract schema or destroy compatibility data until verification and rollback readiness are accepted.
- Require explicit approval before every database migration, reset, cleanup, reseed or destructive action.

## 17. Testing and evidence requirements

Every security-sensitive or business-critical change requires positive and negative tests appropriate to the boundary.

Required negative coverage includes:

- anonymous access;
- missing permissions;
- inactive or absent membership;
- cross-tenant resource IDs;
- cross-warehouse or cross-scope IDs;
- manipulated price, amount, currency, paid, settlement and posting values;
- invalid workflow transitions;
- duplicate and replay requests;
- concurrent state transitions;
- revoked sessions and realtime connections;
- malicious uploads, webhooks, URLs and CSV values;
- assertions that rejection produced no writes, outbox entries, files or external side effects.

Evidence must be labelled as:

- source inspection;
- unit test;
- PostgreSQL integration test;
- Redis integration test;
- infrastructure verification;
- unverified assumption.

Unit tests do not replace PostgreSQL concurrency tests, Redis integration tests, tenant-isolation tests or infrastructure verification.

## 18. Dependency and supply-chain gates

At checkpoint `ec3282cfb1737d90d474eab5e5f504b5a6443d17`, dependency auditing reports 52 unresolved findings: 2 critical, 21 high, 27 moderate and 2 low. Counts do not prove exploitability, but unresolved critical and high findings block production release until triaged.

Dependency remediation requires a separate bounded phase that records:

- package and advisory;
- direct or transitive path;
- production or development classification;
- affected and proposed versions;
- fix availability;
- SemVer compatibility or breaking impact;
- source/runtime reachability;
- validation and rollback results.

Do not use blind `npm audit fix` or `npm audit fix --force`. Breaking upgrades require individual review, isolated changes, compatibility analysis and complete validation.

Release pipelines should gate on reviewed tests, type checking, migration validation, dependency policy, SBOM generation and container scanning.

Generated output is not authoritative source. Tracked, dirty or excluded build output must not be overwritten merely to run validation. Non-emitting checks or isolated temporary output are preferred. Any committed build-artifact update requires a separately reviewed change with reproducible source-to-artifact provenance and confirmation that deployment builds from reviewed source.

## 19. Infrastructure verification boundaries

Source configuration does not prove deployed security. Separate explicit approval is required before inspecting AWS, deployed PostgreSQL, deployed Redis, payment accounts, secrets or production data.

Approved non-production verification should establish:

- public and private network exposure;
- reverse-proxy and trusted-hop behavior;
- TLS termination and internal encryption requirements;
- Redis authentication, ACL, TLS and persistence policy;
- PostgreSQL runtime and migration role separation;
- IAM and object-storage least privilege;
- secret injection and rotation;
- backup, restore and disaster-recovery behavior;
- worker isolation, health and resource limits;
- audit-log protection and retention.

Until verified, these remain unverified infrastructure assumptions.

## 20. Approval gates

Exact explicit approval is required before:

- destructive or production-like migrations;
- database reset, cleanup, truncation, backfill or reseeding;
- access to AWS or deployed infrastructure;
- access to production PostgreSQL or Redis;
- credential or secret use;
- payment-provider or webhook configuration changes;
- production-data operations;
- pushes, deployments or releases;
- broad compatibility removal;
- emergency override introduction.

Approval for one operation does not imply approval for later phases.

## 21. Known unresolved decisions

- Retention periods for operational, financial, audit and personal data.
- Jurisdiction-specific privacy, financial and document requirements.
- Thresholds, if any, that may change maker-checker requirements.
- Detailed legal-entity accounting boundaries beyond operational subledger needs.
- Future platform-access approvers and tenant-visible review procedures.
- Whether and when PostgreSQL RLS should be introduced as defense in depth.
- Dependency upgrade choices where fixes are breaking.
- Recovery-time, recovery-point and disaster-recovery objectives.

## 22. Current release blockers

The checkpoint baseline is a preservation baseline, not release approval. Major unresolved blockers include:

- incomplete tenant ownership and same-tenant relational enforcement;
- public registration privilege escalation through caller-selected company or roles;
- potential password-hash serialization;
- cross-company customer and address references;
- client-authoritative payment states, amounts or currencies;
- missing HTTP rate limiting and undefined shared-limiter outage behavior;
- integration SSRF exposure;
- unsafe proof upload handling, including SVG;
- CSV formula injection;
- authentication, session and refresh-token concurrency gaps;
- incomplete finance legal-entity constraints;
- broad privileged overrides and incomplete maker-checker guarantees;
- Redis event payloads acting as financial authority in selected processing paths;
- unresolved dependency vulnerabilities;
- tracked generated `dist/` output and unresolved source-to-artifact/deployment provenance;
- unverified deployed infrastructure controls.

Release readiness requires evidence-based remediation and validation. No individual unit-test result, audit count or architecture document is sufficient proof of production security.
