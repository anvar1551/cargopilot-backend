# Customer and address tenant scoping

## Enforced behavior in this slice

Customer and address repositories require a complete authenticated user,
tenant-membership and company-membership context. They reload the current
server-side membership, require the applicable `customers.read` or
`customers.write` permission, preserve the existing customer/object scope, and
add the selected tenant to every list, search, count, detail and mutation query.
Missing, stale or partial context fails closed. Customer and address records
whose `tenantId` is null do not match tenant-facing queries.

Customer creation derives `tenantId` from the verified membership. Customer
updates cannot change ownership. Address creation requires an accessible
customer and copies the verified tenant; address updates cannot move the record
to another tenant or customer. Detail, update and delete operations filter the
address through both its tenant and its owning customer.

The new database constraint strengthens customer default addresses from tenant
equality to exact customer ownership. It requires `(tenantId,
defaultAddressId, customer.id)` to match `(tenantId, address.id,
address.customerEntityId)`. It is installed `NOT VALID`: PostgreSQL enforces new
and updated rows while existing transitional rows remain unasserted. Responses
hide any pre-existing default-address relationship that does not match both the
tenant and customer.

## API compatibility

Existing customer and address list/create/detail response shapes are retained.
Repository functions now require the authenticated context as their first
argument and no longer accept a caller-supplied Prisma `where` clause. Customer
and address `PATCH /:id` and `DELETE /:id` endpoints are added, and address
`GET /:id` is added. Request schemas reject unknown ownership fields. Address
creation now always requires `customerEntityId`; the server verifies it rather
than treating it as authority.

## Remaining boundaries

Nullable tenant ownership remains transitional. This slice does not backfill
or validate historical rows, make tenant columns non-null, or implement complete
tenant isolation across other repositories.

Order creation continues to reject customer-master references, structured
address references, and address-book persistence. Lifting that containment
requires the order creation and import paths to pass the verified selected
context into these repositories, prove `customers.read` or `customers.write` as
appropriate, verify each address belongs to the selected customer, retain the
order's company and organization scope checks, and rerun negative cross-tenant
and wrong-customer tests with PostgreSQL evidence.

PostgreSQL row-level security remains planned defense in depth under the
security architecture. It is not implemented or current enforcement here.

Pricing tariff creation and update still resolve `customerEntityId` directly in
the pricing repository. Tariff plans do not yet carry tenant ownership, so that
reference cannot be represented as safely tenant-scoped by this customer CRUD
slice. It remains a blocking follow-up for the pricing tenant cutover; callers
must not treat UUID existence as customer authorization.

## Frontend integration compatibility correction (2026-10-07)

Baseline f363ee54dc68d6d73d6b385b7cc43a4fc47a7417. Actual browser API setup
reproduced a route-import failure: installed Zod 4 rejects `.partial()` on
the refined customer creation schema. Compose the strict base object's
partial/extension first, then apply the same company-field refinement to
both creation and update. No ownership, permission, persistence or field
authority change; no schema/dependency change.

Executed: `node node_modules/jest/bin/jest.js --runInBand
tests/security/customer-route-schema.test.ts
tests/security/customer-address-tenant-containment.test.ts` — 2 suites,
16 cases passed (4 new actual Fastify schema cases with mocked authorization/
repositories; 12 affected service containment regressions). Final
`node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit`
exited 0; the initial default-heap attempt exhausted memory, not a type error.

Browser acceptance used the actual customer/address Fastify routes, fresh
authorization, actual credential/session services and PostgreSQL in an owned
loopback-only disposable instance after 122 existing migrations. Synthetic
controlled onboarding provisioned only prerequisites with an in-memory test
key. Customer creation/edit, address creation/edit/default selection and
authoritative reload worked together; DB read-back found exactly one customer,
one address and one consistent default reference before deletion checks.
Clearing the default and deleting the address/customer through the UI left
zero customer/address rows. All three owned test containers were removed;
no persistent volumes or binds were created. Local test servers stopped.
Automatic approval review rejected cleanup of the owned frontend source copy
and two public-test-key registry directories; they remain for manual cleanup,
as recorded in frontend `docs/Workflow_Coverage.md`.
Production login admission/full application boot, Redis, AWS, providers and
real deployment were not exercised. Existing database negative ownership/
constraint evidence remains at its previously reported level.

Customer/address mutations still have no durable server retry receipts.
The new frontend persists context-bound intent before sending and suppresses
automatic replay; uncertain outcomes remain reconciliation-required. This
does not prove server duplicate protection or add a recovery contract.
