# Additive tenant schema foundation

Base: `187cd17e500fa3f04b3bb2716a0dee5341a88236`.

This expansion adds tenant identity, tenant membership and nullable ownership or
session bridge columns. It does not establish tenant isolation. No mapping,
backfill, dual write, application cutover or database migration execution is part
of this change.

## Present consistency constraints

- `TenantMembership` is unique per tenant and user. Its composite identity
  `(id, userId, tenantId)` is a foreign-key target.
- A populated `CompanyMembership` bridge references that composite identity, so
  it cannot bind to a `TenantMembership` belonging to another user or tenant.
- A populated refresh-session bridge references the exact composite
  `(CompanyMembership.id, tenantMembershipId, userId, tenantId)`, so it cannot
  combine a session user, tenant membership and company membership from different
  identities or tenants.
- SQL checks make each compatibility bridge all-null or all-populated. This avoids
  PostgreSQL nullable composite foreign-key behavior accepting a partial bridge.
- Every populated business `tenantId` references an existing `Tenant` with
  restrictive deletion. Tenant-leading indexes and composite unique targets are
  available for later same-tenant foreign keys.
- Existing `Organization`, `CompanyMembership`, `FinanceLegalEntity.companyId`,
  `Invoice.companyId` and order ownership relations remain intact. Tenant equality
  does not replace company or legal-entity equality.

## Deferred until backfill and contract migration

Nullable ownership permits legacy rows with no tenant and therefore provides no
isolation by itself. This expansion does not yet ensure that:

- a `CompanyMembership.companyId` organization has its bridge tenant;
- organization parents and children share a tenant;
- an address and its customer/default customer share a tenant;
- an order, owner organization, warehouse, customer and addresses share a tenant;
- an invoice, order, company, customer and finance legal entity share a tenant;
- tenant ownership exists on every row or on other tenant-owned bounded contexts.

Those relationships require an approved deterministic mapping, explicit handling
of ambiguous/orphaned records, backfill verification, application dual writes and
PostgreSQL-tested compound foreign keys before ownership becomes non-null. No
existing company is assumed to be a separate tenant and no default tenant is
assigned.

## Session planning corrections

A tenant selector is insufficient when the user has multiple company memberships
inside that tenant. Future session binding must resolve an explicit authorized
`CompanyMembership` as well as the active `TenantMembership`; it must never choose
an arbitrary first company membership. The nullable refresh-session fields model
that future exact selection but are not read or written by current authentication.

Rollback must preserve the tenant enforcement active at that deployment stage or
disable the affected operations. It must not restore unscoped reads or writes.
Additive columns and legacy identifiers should remain available during rollback;
removing application enforcement is not an acceptable compatibility strategy.

## Evidence boundary and next step

The reported offline Prisma WASM validation establishes schema syntax and relation
validity. Manual source review compared the additive schema and authored migration;
the existing SQL checklist verifies expected names and selected text patterns, not
complete semantic schema-to-SQL equivalence. PostgreSQL DDL execution, constraint
validation, locking, table-scan duration and deployment compatibility remain
unverified.
The next stage is an approved mapping and read-only data assessment, followed by a
separately reviewed backfill/dual-write plan. The migration must not be applied
until isolated PostgreSQL execution validates the expansion and rollback plan.
