# Order tenant scoping

## Current enforced behavior in this slice

- Core order list, search, count, detail, CSV export and driver-workload queries combine the freshly verified selected tenant with the existing organization, warehouse, customer and assigned-driver scope predicate. Orders with a null `tenantId` are therefore hidden.
- New orders derive `tenantId` and `ownerOrgId` from the active tenant-bound `CompanyMembership`. Request fields cannot select `tenantId`, owner or assignment authority. Customer/address master references remain rejected in order creation.
- Core deletion first resolves the order through the tenant and object scope and uses the resolved tenant again for the final delete. A rejected lookup performs no delete or storage cleanup.
- Core assignment and status queries include the selected tenant. Warehouse references require both matching tenant ownership and an explicit selected-membership warehouse scope. Driver assignment requires an active membership in the selected tenant and company. Mutation counts are checked before tracking/outbox writes in the transaction.
- Read-cache keys include tenant, selected company membership and user. This prevents a cached order list from being reused under another selected membership.
- Order creation still enforces server pricing, rejects paid/status and pricing-authority inputs, and leaves online checkout pending until an invoice exists.

## Compatibility effects

- Legacy orders with null tenant ownership no longer appear in core order reads and cannot be changed or deleted through the covered paths.
- Clients that send `tenantId`, `ownerOrgId`, `assignedOrgId`, `currentWarehouseId` or `assignedDriverId` in order-creation payloads receive a 403 response.
- A warehouse supplied to a status or assignment operation now requires an explicit warehouse scope (or the actor's verified, same-tenant warehouse assignment). Company scope alone cannot prove authority over a warehouse.
- A driver must have an active company membership in the selected company. A user-global driver identity is insufficient.
- Response shapes and event names are unchanged. New orders now populate the existing nullable `Order.tenantId` column.

## Slice boundaries and remaining gaps

- The database ownership constraints still allow nullable tenant combinations described in the tenant ownership migration documentation. This slice hides null orders at covered application boundaries; it does not backfill or make ownership columns non-null.
- Dispatch has only the reference and order-scope containment above. Driver workload policy, assignment lifecycle, dispatch concurrency and broader driver/warehouse membership modelling remain separate work.
- Cash collection, proof, labels, support, transport-leg and other order-adjacent repositories still require a complete caller-by-caller tenant scoping review. Their direct calls to order repositories must not be treated as covered by this core API slice.
- The import path uses the same tenant-bound creation function for successful rows and retains customer/address and financial containment. Its documented partial-success behavior and recovery/idempotency gaps remain unchanged.
- Nested parcels, tracking, attachments and cash collections are reached only after an authorized parent order in the covered detail response, but those child tables do not all carry direct tenant ownership. Direct child endpoints and background jobs remain release gates.
- Existing assigned-driver relationships are not constrained in PostgreSQL by tenant/company membership. This slice validates new core assignments in application code; database defense in depth and already-populated rows remain unresolved.
- RLS remains deferred defense in depth. No claim of complete runtime tenant isolation or production readiness is made.

## Evidence level

Focused Jest tests use a mocked Prisma boundary to prove generated tenant/object predicates and that selected rejected mutations issue no business writes. Type checking proves TypeScript consistency. Existing PostgreSQL ownership-constraint evidence remains applicable to the unchanged schema, but this slice has no new migration and does not provide live transport, database concurrency or RLS evidence.
